// https://nuxt.com/docs/api/configuration/nuxt-config
import { defineNuxtConfig } from "nuxt/config";

/* eslint sort-keys: "error" */
export default defineNuxtConfig({
  devtools: {
    enabled: false, // Toggle this to enable devtools.
  },

  imports: {
    autoImport: false,
  },

  modules: ["@pinia/nuxt", "nuxt-security"],

  nitro: {
    esbuild: {
      options: {
        target: "node18",
      },
    },
  },

  // These can be set per the instructions in
  // https://nuxt.com/docs/guide/directory-structure/env. All options that are
  // undefined here are required to be set in env params.
  //
  // This is unstable software; required options, option availability, and
  // option interpretation can change between versions. Check the changelog or
  // commit history when upgrading
  runtimeConfig: {
    // Whether to error out if episodes are missing, or simply print a warning.
    allowMissingEpisodes: true,
    // Required. Where the episode data config is. See README.md for more info.
    episodeDataPath: undefined,
    // How often to check imageOutputDir and answer storage for expired images.
    imageCleanupIntervalMs: 30 * 60 * 1000, // 30 minutes.
    imageExpiryMs: 10 * 60 * 1000, // 10 minutes.
    imageGenMaxParallelism: 3,
    // Where generated images will be outputted to and served from. Apparently
    // orphaned images will be cleaned out of this directory, so don't point it
    // to somewhere that has important data!
    imageOutputDir: "/tmp/genimg",
    imagePregenCount: 3,
    // Per Nuxt documentation, these values will be sent to client-side code.
    public: {
      imageOutputExtension: "webp",
      // Instance info that will be shown in the About section. This allows HTML
      // tags; use this if you want to include HTML. You might want to include a
      // way for users to contact you if there are problems.
      instanceInfoHtml: undefined,
      // Instance info, but allowing plain text only; use this for safety if you
      // don't need to include HTML.
      instanceInfoText: undefined,
      // Required. Instance name shown to users.
      instanceName: undefined,
      // Name of the media; shown to users in the description.
      mediaName: undefined,
      // Link to your version of the source code. If you build and run a
      // modified version of this software to users over a network, the AGPL
      // requires you to provide users with a link to view/download your
      // modified version. If you don't provide a different link here, you
      // attest that your instance's code is unmodified.
      sourceCodeUrl: "https://github.com/steadygaze/frame-randomizer/",
    },
    // Whether to search subdirectories of videoSourceDir. Directory path is not
    // considered when deciding season/episode number, only filename.
    searchVideoDirRecursively: false,
    // Used to give generated images random names. Recommend setting this to a
    // different one for your own instance from:
    // https://www.uuidtools.com/generate/v4
    uuidNamespace: "b219dcdb-c910-417c-8403-01c6b40c5fb4",
    // Required. Where source videos are found. Files should include the season
    // and episode numbers in SxxExx or xx,xx format or similar.
    videoSourceDir: undefined,
  },

  security: {
    headers: {
      // Allow devtools to work.
      crossOriginEmbedderPolicy:
        process.env.NODE_ENV === "development" ? "unsafe-none" : "require-corp",
    },
    rateLimiter: {
      interval: "hour",
      throwError: false,
      // One generated image and guess every 5 seconds.
      tokensPerInterval: 720 * 2,
    },
  },

  typescript: {
    strict: true,
    typeCheck: true,
  },
});
