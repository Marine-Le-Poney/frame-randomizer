import { exec as execAsync } from "node:child_process";
import fs from "fs/promises";
import { promisify } from "node:util";
import once from "lodash.once";
import { ProducerQueue } from "./queue";
import { StoredAnswer, StoredFileState } from "./types";
import {
  ServerEpisodeData,
  ShowData,
  findFiles,
  imagePathForId,
  lsAllFiles,
  offsetTimeBySkipRanges,
} from "./file";
import { myUuid } from "./utils";
import logger from "./logger";

const exec = promisify(execAsync);

/**
 * Gets episode data from the specified config file, and joins it with file
 * information.
 * @param runtimeConfig Runtime config options.
 * @returns Episode data list, with an entry for each episode.
 */
async function getShowdataUncached(
  runtimeConfig: ReturnType<typeof useRuntimeConfig>,
): Promise<ShowData> {
  const start = Date.now();
  const [rawShowDataString, fileData] = await Promise.all([
    fs.readFile(runtimeConfig.showDataPath, { encoding: "utf-8" }),
    lsAllFiles(runtimeConfig),
    fs
      .mkdir(runtimeConfig.frameOutputDir, { recursive: true })
      .catch((error) => {
        if (
          !(error instanceof Object) ||
          !("code" in error) ||
          error.code !== "EEXIST"
        ) {
          throw error;
        }
        // Ignore if dir already exists.
      }),
  ]);
  const rawShowData = JSON.parse(rawShowDataString);
  const showData = await findFiles(runtimeConfig, rawShowData, fileData);
  logger.info(
    `Loaded ${showData.episodes.length} episodes in ${Date.now() - start} ms`,
  );
  return showData;
}

const getShowData = once(getShowdataUncached);

/**
 * Generates a random time in an episode in seconds, considering skip ranges.
 *
 * For example, if an episode is 60 seconds long, and the first 10 seconds are
 * skipped, we will generate a number between 0 and 50, and then return that
 * number plus 10.
 * @param episode Episode data object.
 * @returns Random time, in seconds.
 */
function randomTimeInEpisode(episode: ServerEpisodeData): number {
  const randomUnoffsetTime = Math.random() * episode.genLength;
  const offsetTime = Math.min(
    offsetTimeBySkipRanges(randomUnoffsetTime, episode.skipRanges),
    episode.length,
  );
  // Rounded to the nearest frame.
  const rounded =
    Math.round(offsetTime * episode.framerate) / episode.framerate;
  logger.info("rounded time", {
    offsetTime,
    rounded,
    season: episode.season_number,
    episode: episode.episode_number,
  });
  return rounded;
}

interface RandomEpisode {
  episode: ServerEpisodeData;
  seekTime: number | string;
}

/**
 * Calls ffmpeg to run the command to extract a particular frame.
 * @param config Nuxt runtime config.
 * @param chooseFrame Function to call to try another frame.
 * @param outputPath Path to output the image to (including file extension).
 * @returns Promise to await on completion.
 */
async function ffmpegFrame(
  config: ReturnType<typeof useRuntimeConfig>,
  chooseFrame: () => RandomEpisode,
  outputPath: string,
): Promise<RandomEpisode> {
  const ffmpeg = config.ffmpegPath;
  const identify = config.imageMagickIdentifyPath;
  const inject = config.ffmpegImageCommandInject;
  const maxRejects = config.frameGenMaxAttempts;
  const requiredStddev = config.frameRequiredStandardDeviation;

  const start = Date.now();
  let rejected = -1;
  let random;
  do {
    ++rejected;
    random = chooseFrame();
    await exec(
      `${ffmpeg} -ss ${random.seekTime} -i ${
        random.episode.filename
      } -frames:v 1 -update true ${inject || ""} -y ${outputPath}`,
    );
  } while (
    /* eslint-disable-next-line no-unmodified-loop-condition -- Other conditions modified. */
    requiredStddev > 0 &&
    rejected < maxRejects &&
    parseInt(
      (await exec(`${identify} -format '%[standard_deviation]' ${outputPath}`))
        .stdout,
    ) < requiredStddev
  );
  logger.info(`New image generated in ${Date.now() - start} ms`, {
    file: outputPath,
    rejected,
  });
  return random;
}

/**
 * Scans persistent storage to find all unserved frames that can be requeued.
 * @param config Runtime config options.
 * @returns List of recoverable frames.
 */
async function recoverFrames(config: ReturnType<typeof useRuntimeConfig>) {
  const answerStorage = useStorage("answer");
  const frameStorage = useStorage("frameState");

  const ids = await frameStorage.getKeys();
  let noAnswer = 0;
  let unservedAnswer = 0;
  let cleanedFileAnswer = 0;
  let servedFile = 0;
  let recoveredCount = 0;
  let missingFile = 0;

  const recovered = (
    await Promise.all(
      ids.map(async (id) => {
        const [fileData, answerData] = await Promise.all([
          frameStorage.getItem<StoredFileState>(id),
          answerStorage.getItem<StoredAnswer>(id),
        ]);
        if (fileData && !answerData) {
          ++noAnswer;
          // Answer lost, so even if we have the file, it's unusable.
          frameStorage.removeItem(id);
          // Don't care if this fails with ENOENT.
          fs.rm(imagePathForId(config, id)).catch();
          return "";
        }
        if (!fileData && answerData) {
          if (!answerData.expiryTs) {
            ++unservedAnswer;
            // Answer is supposedly for an unserved frame, but there is no frame
            // data. Delete this inconsistent data.
            answerStorage.removeItem(id);
          } else {
            ++cleanedFileAnswer;
          }
          // Otherwise, file may be cleaned up but there may be a pending answer;
          // don't delete the answer.
          return "";
        }
        if (fileData && fileData.expiryTs) {
          ++servedFile;
          // Already served image.
          return "";
        }
        try {
          await fs.stat(imagePathForId(config, id));
          ++recoveredCount;
          return id;
        } catch (e) {
          ++missingFile;
          // Probably ENOENT, or the image file is otherwise inaccessible.
          // No need to await.
          frameStorage.removeItem(id);
          if (!answerData || !answerData.expiryTs) {
            answerStorage.removeItem(id);
          }
          return "";
        }
      }),
    )
  )
    .filter((id) => id)
    .map((imageId) => {
      return { imageId };
    });

  return {
    recovered,
    stats: {
      noAnswer,
      unservedAnswer,
      cleanedFileAnswer,
      servedFile,
      recoveredCount,
      missingFile,
    },
  };
}

/**
 * Gets a frame producer queue, which manages generating new frames, returning
 * pregenerated frames, etc.
 * @param config Runtime config options.
 * @returns Producer queue on the image IDs generated.
 */
async function getFrameProducerQueueUncached(
  config: ReturnType<typeof useRuntimeConfig>,
): Promise<ProducerQueue<{ imageId: string }>> {
  const { episodes } = await getShowData(config);
  const answerStorage = useStorage("answer");
  const frameStateStorage = useStorage("frameState");

  /**
   * Generate a random episode and a random time in the episode.
   * @returns Episode data and seek time.
   */
  function chooseRandomFrame(): RandomEpisode {
    const episode = episodes[Math.floor(Math.random() * episodes.length)];
    const seekTime = randomTimeInEpisode(episode);
    return { episode, seekTime };
  }

  /**
   * Performs all jobs associated with generating a frame.
   *
   * This includes generating the frame, and storing the "answer" (what episode
   * the frame is from) in storage.
   * @returns ID of the image generated.
   */
  async function generateFrame() {
    const imageId = myUuid(config);
    const imagePath = imagePathForId(config, imageId);

    // Record that we generated this file.
    const storeImageIdP = frameStateStorage.setItem(imageId, {
      expiryTs: null,
    });
    const { episode, seekTime } = await ffmpegFrame(
      config,
      chooseRandomFrame,
      imagePath,
    );

    await Promise.all([
      // If we returned the image path to the client without awaiting on ffmpeg,
      // they might try to load the image before it's done generating.
      // We do await on storing the answer despite this not affecting the query
      // result to prevent a rare data race between the answer being stored and
      // the client checking their guess.
      answerStorage.setItem(imageId, {
        season: episode.season_number,
        episode: episode.episode_number,
        seekTime,
        expiryTs: null,
      } as StoredAnswer),
      // We have to await on this because otherwise it can race with setting the
      // expiry time when serving.
      storeImageIdP,
    ]);
    return { imageId };
  }

  const { recovered, stats } = await recoverFrames(config);
  logger.info(
    `Recovered ${recovered.length} unserved frames from previous runs`,
    stats,
  );

  return new ProducerQueue(generateFrame, recovered, {
    length: config.framePregenCount,
    maxPending: config.frameGenMaxParallelism,
    maxRetries: config.frameGenMaxAttempts,
  });
}

const getFrameProducerQueue = once(getFrameProducerQueueUncached);

export { getShowData, getFrameProducerQueue };
