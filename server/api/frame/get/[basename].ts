import fsAsync from "node:fs";
import path from "path";
import { sendStream } from "h3";
import { logger } from "~/server/logger";
import { cleanupFrame } from "~/server/cleanup";
import { logFetchToRun } from "~/server/serve";

const config = useRuntimeConfig();
const runStateStorage = useStorage("runState");

const traversingPathRe = /[/\\]|\.\./;

export default defineEventHandler((event) => {
  const basename = getRouterParam(event, "basename");
  const cleanuponload = getQuery(event).cleanuponload;

  if (!basename) {
    throw createError({ statusCode: 404 });
  }
  if (
    traversingPathRe.test(basename) ||
    !basename.endsWith(`.${config.public.imageOutputExtension}`)
  ) {
    // Prevent path traversal security vulnerability, or attempt to access other
    // file extensions.
    throw createError({ statusCode: 400 });
  }

  const runId = getQuery(event).runId;

  const file = path.join(config.frameOutputDir, basename);
  try {
    const stream = fsAsync.createReadStream(file);
    const id = basename.slice(
      0,
      basename.length - (config.public.imageOutputExtension.length + 1),
    );
    if (runId) {
      // The "close" and "ready" events usually occur within milliseconds, and
      // don't actually reflect when the image is done sending to the client.
      stream.on(
        "close",
        async () => await logFetchToRun(id, String(runId), runStateStorage),
      );
    }
    if (cleanuponload && cleanuponload !== "false" && cleanuponload !== "0") {
      stream.on("close", () => {
        logger.info("Cleaning up frame on load", { id });
        cleanupFrame(id, false);
      });
    }
    return sendStream(event, stream);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      // Tried to get a file path that doesn't exist.
      logger.error("Got request for nonexistent frame", {
        file,
      });
      throw createError({ statusCode: 404 });
    } else {
      logger.error("Unknown error when serving frame", {
        error,
      });
      throw createError({ statusCode: 500 });
    }
  }
});
