import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { glob } from "glob";
import intersection from "lodash.intersection";
import { StoredAnswer, StoredFileState, StoredRunData } from "../types";
import { imagePathForId } from "../file";
import { logger } from "../logger";

const config = useRuntimeConfig();
const sleep = promisify(setTimeout);
const answerStorage = useStorage("answer");
const archivedRunStorage = useStorage("archivedRun");
const frameStateStorage = useStorage("frameState");
const runStateStorage = useStorage("runState");

/**
 * Clean up expired answers.
 */
async function cleanupAnswers() {
  const answerIds = await answerStorage.getKeys();
  await Promise.all(
    answerIds.map(async (answerId) => {
      const answerInput = await answerStorage.getItem(answerId);
      const answer = answerInput as StoredAnswer | null;
      if (answer && answer.expiryTs && answer.expiryTs < Date.now()) {
        logger.info(`Cleaning up expired answer`, { id: answerId });
        await answerStorage.removeItem(answerId).catch((error) => {
          logger.error(`Failed to clean up stored answer: ${error}`, {
            id: answerId,
          });
        });
      }
    }),
  );
}

/**
 * Cleans up images in the output dir not tracked or owned by the server.
 * @param frameFileIds File IDs of all current frames.
 * @param frames1 List of frames, first sample.
 * @param frames2 List of frames, second sample.
 */
async function cleanupOrphanedImages(
  frameFileIds: string[],
  frames1: string[],
  frames2: string[],
) {
  const ext = config.public.imageOutputExtension;
  const filenameToKeyRe = new RegExp(`/(?<key>[0-9a-f\\-]+)\\.${ext}$`);
  await Promise.all(
    intersection(frames1, frames2)
      .map((frameFile) => {
        const match = filenameToKeyRe.exec(frameFile);
        if (
          match &&
          match.length > 0 &&
          match.groups &&
          !frameFileIds.includes(match.groups.key)
        ) {
          logger.info(`Cleaning up apparently orphaned image`, {
            file: frameFile,
          });
          return [
            fs.rm(frameFile).catch((error) => {
              logger.error(`Failed to clean up orphaned image: ${error}`, {
                file: frameFile,
              });
            }),
          ];
        }
        return [];
      })
      .flat(),
  );
}

/**
 * Cleans up frames that have expired.
 * @param frameFileIds List of frames tracked.
 */
async function cleanupExpiredImages(frameFileIds: string[]) {
  await Promise.all(
    frameFileIds.map(async (fileId) => {
      const storedFileState = (await frameStateStorage.getItem(
        fileId,
      )) as StoredFileState | null;
      if (
        storedFileState &&
        storedFileState?.expiryTs &&
        storedFileState?.expiryTs <= Date.now()
      ) {
        const frameFile = imagePathForId(config, fileId);
        logger.info(`Cleaning up expired image`, { file: frameFile });
        await Promise.all([
          frameStateStorage.removeItem(fileId),
          fs.rm(frameFile).catch((error) => {
            if (error.code !== "ENOENT") {
              logger.error(`Failed to clean up expired image: ${error}`, {
                file: frameFile,
              });
            }
          }),
        ]);
      }
    }),
  );
}

/**
 * Cleans up orphaned and expired frames.
 */
async function cleanupOrphanedAndExpiredImages() {
  const ext = config.public.imageOutputExtension;
  const globPattern = path.join(config.frameOutputDir, `*.${ext}`);
  const [frameFileIds, frames1, frames2] = await Promise.all([
    frameStateStorage.getKeys(),
    // List the files twice to avoid race conditions with storage cleanup.
    // Frames will be cleaned up only if they are present both times.
    glob(globPattern),
    sleep(1000).then(() => glob(globPattern)),
  ]);
  await Promise.all([
    cleanupOrphanedImages(frameFileIds, frames1, frames2),
    cleanupExpiredImages(frameFileIds),
  ]);
}

/**
 * Cleans up expired, unimportant runs and archives the important runs.
 */
async function cleanupExpiredRuns() {
  const keys = await runStateStorage.getKeys();
  await Promise.all(
    keys.map(async (runId) => {
      const data = await runStateStorage.getItem<StoredRunData>(runId);
      if (data && (!data.expiryTs || data.expiryTs < Date.now())) {
        const work = [runStateStorage.removeItem(runId)];
        if (data.history.length >= config.runRetentionThreshold) {
          data.expiryTs = null;
          work.push(archivedRunStorage.setItem(runId, data));
          logger.info("Archived important run", { runId });
        } else {
          logger.info("Cleaned up unimportant run", { runId });
        }
        await Promise.all(work);
      }
    }),
  );
}

export default defineNitroPlugin(() => {
  setInterval(async () => {
    const start = Date.now();
    await Promise.all([
      cleanupAnswers(),
      cleanupOrphanedAndExpiredImages(),
      cleanupExpiredRuns(),
    ]);
    logger.info(`Image cleanup done in ${Date.now() - start} ms`);
  }, config.cleanupIntervalMs);
});
