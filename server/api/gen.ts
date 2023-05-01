import path from "node:path";
import { exec as execAsync } from "node:child_process";
import { promisify } from "node:util";
import { RuntimeConfig } from "nuxt/schema";
import { getEpisodeData } from "../load";
import { myUuid } from "~~/utils/utils";
import { StoredAnswer } from "~/server/types";
import { EpisodeDatum, offsetTimeBySkipRanges } from "~/utils/file";

const config = useRuntimeConfig() as RuntimeConfig;
const exec = promisify(execAsync);
const storage = useStorage("genimg");

function randomTimeInEpisode(episode: EpisodeDatum) {
  const randomUnoffsetTime = Math.random() * episode.genLength;
  const offsetTime = Math.min(
    offsetTimeBySkipRanges(randomUnoffsetTime, episode.skipRanges),
    episode.lengthSec
  );
  return offsetTime;
}

async function ffmpegFrame(
  videoPath: string,
  timecode: number | string,
  outputPath: string
) {
  const ts = Date.now();
  await exec(
    `ffmpeg -ss ${timecode} -i ${videoPath} -frames:v 1 -f image2 -update true -y ${outputPath}`
  );
  const delta = Date.now() - ts;
  console.log("Image outputted in", delta, "ms to", outputPath);
}

export default defineLazyEventHandler(async () => {
  const episodeData = await getEpisodeData(config);

  return defineEventHandler(async () => {
    const imageId = myUuid(config);
    const imagePath = path.join(
      config.imageOutputDir,
      `${imageId}.${config.public.imageOutputExtension}`
    );
    const episode = episodeData[Math.floor(Math.random() * episodeData.length)];
    const seekTime = randomTimeInEpisode(episode);
    await Promise.all([
      // If we returned the image path to the client without awaiting on ffmpeg,
      // they might try to load the image before it's done generating.
      ffmpegFrame(episode.filename, seekTime, imagePath),
      // We do await on storing the answer despite this not affecting the query
      // result to prevent a rare data race between the answer being stored and
      // the client checking their guess.
      storage.setItem(imageId, {
        season: episode.season,
        episode: episode.episode,
        seekTime,
      } as StoredAnswer),
    ]);
    return { imageId };
  });
});
