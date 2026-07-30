const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  closeRenderSession,
  createRenderSession
} = require("../scripts/maze-render-frame");

const ROOT_DIR = path.resolve(__dirname, "..");
const BROWSERS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
];

function hasBrowser() {
  return (
    BROWSERS.some((browser) => fs.existsSync(browser)) ||
    fs.existsSync("/ms-playwright") ||
    Boolean(process.env.PLAYWRIGHT_BROWSERS_PATH)
  );
}

async function main() {
  if (!fs.existsSync(path.join(ROOT_DIR, "node_modules", "playwright-core"))) {
    console.log("strict-model-readiness: skipped (playwright-core is not installed)");
    return;
  }
  if (!hasBrowser()) {
    console.log("strict-model-readiness: skipped (no Chromium-family browser is installed)");
    return;
  }

  const session = await createRenderSession({
    actions: [],
    draft: true,
    fast: true,
    gameId: "maze",
    height: 128,
    levelId: "level_HxI",
    view: "top-diagonal",
    width: 128,
    yaw: 0
  });
  const validModel = fs.readFileSync(
    path.join(ROOT_DIR, "games", "maze", "assets_3d", "gem.glb")
  );
  const requests = new Map();

  try {
    await session.page.route("**/__strict-model-readiness__/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const count = (requests.get(pathname) || 0) + 1;
      requests.set(pathname, count);

      if (pathname.endsWith("/retry.glb") && count === 1) {
        await route.fulfill({
          body: Buffer.from("not a glb"),
          contentType: "model/gltf-binary",
          status: 200
        });
        return;
      }

      if (pathname.endsWith("/terminal.glb")) {
        await route.fulfill({ body: "unavailable", status: 503 });
        return;
      }

      await route.fulfill({
        body: validModel,
        contentType: "model/gltf-binary",
        status: 200
      });
    });

    const states = [
      {
        actors: [
          { modelUrl: "/__strict-model-readiness__/actor.glb" },
          { modelUrl: "/__strict-model-readiness__/cell.glb" }
        ],
        terrain: [
          [
            {
              layers: [
                {
                  layers: [
                    { modelUrl: "/__strict-model-readiness__/deep-layer.glb" }
                  ],
                  modelUrl: "/__strict-model-readiness__/retry.glb"
                }
              ],
              modelUrl: "/__strict-model-readiness__/cell.glb",
              underlay: {
                layers: [
                  {
                    underlay: {
                      modelUrl: "/__strict-model-readiness__/deep-underlay.glb"
                    }
                  }
                ],
                modelUrl: "/__strict-model-readiness__/underlay.glb"
              }
            }
          ]
        ]
      },
      {
        actors: [{ modelUrl: "/__strict-model-readiness__/actor.glb" }],
        terrain: [[{ modelUrl: "/__strict-model-readiness__/deep-layer.glb" }]]
      }
    ];

    await session.page.evaluate(async (levelStates) => {
      const app = window.__PIXEL_GAME_APP__;
      await app.threeRenderer.requireLevelStatesModelsReady(levelStates, {
        retries: 1,
        retryDelayMs: 0
      });
    }, states);

    [
      "actor.glb",
      "cell.glb",
      "deep-layer.glb",
      "deep-underlay.glb",
      "underlay.glb"
    ].forEach((filename) => {
      assert.equal(
        requests.get(`/__strict-model-readiness__/${filename}`),
        1,
        `${filename} should be fetched exactly once after URL deduplication`
      );
    });
    assert.equal(
      requests.get("/__strict-model-readiness__/retry.glb"),
      2,
      "a parse failure should clear both caches and retry with fresh bytes"
    );

    await session.page.evaluate(async (levelStates) => {
      await window.__PIXEL_GAME_APP__.threeRenderer.requireLevelStatesModelsReady(levelStates);
    }, states);
    assert.equal(
      requests.get("/__strict-model-readiness__/cell.glb"),
      1,
      "already-ready models should be reused"
    );

    const terminal = await session.page.evaluate(async () => {
      const renderer = window.__PIXEL_GAME_APP__.threeRenderer;
      const levelState = {
        actors: [
          { modelUrl: "/__strict-model-readiness__/terminal.glb" },
          { modelUrl: "/__strict-model-readiness__/terminal.glb" }
        ],
        terrain: [
          [{ layers: [{ modelUrl: "/__strict-model-readiness__/terminal.glb" }] }]
        ]
      };

      try {
        await renderer.requireLevelStatesModelsReady([levelState], {
          retryDelayMs: 0
        });
        return null;
      } catch (error) {
        return {
          message: error.message,
          modelUrls: error.modelUrls,
          name: error.name
        };
      }
    });

    assert.deepEqual(terminal, {
      message:
        "Required 3D model assets failed to load: /__strict-model-readiness__/terminal.glb",
      modelUrls: ["/__strict-model-readiness__/terminal.glb"],
      name: "ModelAssetLoadError"
    });
    assert.equal(
      requests.get("/__strict-model-readiness__/terminal.glb"),
      2,
      "the default retries=1 should make two total attempts"
    );

    await session.page.evaluate(async () => {
      await window.__PIXEL_GAME_APP__.threeRenderer.whenLevelStateModelsReady({
        actors: [{ modelUrl: "/__strict-model-readiness__/terminal.glb" }],
        terrain: []
      });
    });
    assert.equal(
      requests.get("/__strict-model-readiness__/terminal.glb"),
      2,
      "the existing permissive readiness API should keep accepting a cached fallback"
    );
  } finally {
    await closeRenderSession(session);
  }

  console.log("strict-model-readiness: strict retry, traversal, and terminal failure verified");
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
