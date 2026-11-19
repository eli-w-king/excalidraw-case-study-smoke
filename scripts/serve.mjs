// Starts the dev server (npm start) or serves the production build
// (npm run preview) on the first free port from 3000 up, prints the URL and
// writes it to .workshop/server.json (or .workshop/preview.json) so agents
// can find it.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const isPreview = args.includes("--preview");
const portArgIndex = args.indexOf("--port");
const firstPort = portArgIndex >= 0 ? Number(args[portArgIndex + 1]) : 3000;
const host = "127.0.0.1";
const configFile = path.join(repoRoot, "excalidraw-app", "vite.config.mts");
const infoFile = path.join(
  repoRoot,
  ".workshop",
  isPreview ? "preview.json" : "server.json",
);

const hasPackages = (folder) =>
  fs.existsSync(path.join(folder, "node_modules", "vite", "package.json"));

// In a git worktree (for example a parallel session's), borrow the main
// checkout's node_modules through a link instead of installing again.
const linkMainCheckoutPackages = () => {
  const list = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (list.status !== 0) {
    return false;
  }
  const mainLine = list.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith("worktree "));
  const main = mainLine && path.resolve(mainLine.slice("worktree ".length));
  if (
    !main ||
    fs.realpathSync(main) === fs.realpathSync(repoRoot) ||
    !hasPackages(main)
  ) {
    return false;
  }
  const link = path.join(repoRoot, "node_modules");
  try {
    if (fs.lstatSync(link).isSymbolicLink()) {
      fs.unlinkSync(link);
    } else {
      return false;
    }
  } catch {
    // no node_modules yet
  }
  // "junction" makes a directory link on Windows without admin rights;
  // elsewhere it's a normal symlink
  fs.symlinkSync(path.join(main, "node_modules"), link, "junction");
  console.log(
    `\n  Using the packages from the main checkout (${main}), no second install.\n`,
  );
  return true;
};

const ensureInstalled = () => {
  if (hasPackages(repoRoot)) {
    return;
  }
  try {
    if (linkMainCheckoutPackages()) {
      return;
    }
  } catch (error) {
    console.warn(`  Couldn't link the main checkout's packages: ${error.message}`);
  }
  console.log("\n  Installing packages first (npm ci). This takes a minute.\n");
  const isWindows = process.platform === "win32";
  const result = spawnSync(isWindows ? "npm.cmd" : "npm", ["ci"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: isWindows,
  });
  if (result.status !== 0) {
    console.error("\n  npm ci failed. Fix the error above, then run npm start again.\n");
    process.exit(result.status || 1);
  }
};

const canListen = (port, address) =>
  new Promise((resolve) => {
    const tester = net.createServer();
    tester.once("error", (error) => {
      // a machine without IPv6 is fine
      resolve(error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT");
    });
    tester.once("listening", () => tester.close(() => resolve(true)));
    tester.listen(port, address);
  });

const findFreePort = async (start) => {
  for (let port = start; port < start + 100; port++) {
    if ((await canListen(port, host)) && (await canListen(port, "::1"))) {
      return port;
    }
  }
  throw new Error(`No free port between ${start} and ${start + 99}.`);
};

const writeInfo = (info) => {
  fs.mkdirSync(path.dirname(infoFile), { recursive: true });
  fs.writeFileSync(infoFile, `${JSON.stringify(info, null, 2)}\n`);
};

const removeInfo = () => {
  try {
    const info = JSON.parse(fs.readFileSync(infoFile, "utf8"));
    if (info.pid === process.pid) {
      fs.unlinkSync(infoFile);
    }
  } catch {
    // already gone
  }
};

const main = async () => {
  ensureInstalled();

  if (isPreview && !fs.existsSync(path.join(repoRoot, "dist", "index.html"))) {
    console.error("\n  There's no build yet. Run npm run build first.\n");
    process.exit(1);
  }

  const vite = await import("vite");
  const freePort = await findFreePort(
    Number.isFinite(firstPort) ? firstPort : 3000,
  );

  // If another server grabs the port first (several sessions starting at
  // once), Vite moves on to the next one, so read the port it really got.
  const server = isPreview
    ? await vite.preview({
        configFile,
        preview: { port: freePort, strictPort: false, host },
      })
    : await vite.createServer({
        configFile,
        server: { port: freePort, strictPort: false, host },
      });

  if (!isPreview) {
    await server.listen();
  }

  const address = server.httpServer?.address();
  const port = address && typeof address === "object" ? address.port : freePort;
  const base = server.config.base || "/";
  const url = `http://${host}:${port}${base}`;
  writeInfo({
    url,
    reviewUrl: `${url}review/`,
    port,
    mode: isPreview ? "preview" : "dev",
    pid: process.pid,
    cwd: repoRoot,
    startedAt: new Date().toISOString(),
  });

  console.log(
    [
      "",
      `  Excalidraw is running at ${url}`,
      `  The page for everyone:   ${url}review/`,
      "",
      `  Saved to ${path.join(".workshop", path.basename(infoFile))}. Press Ctrl+C to stop.`,
      "",
    ].join("\n"),
  );

  let stopping = false;
  const stop = async () => {
    if (stopping) {
      return;
    }
    stopping = true;
    removeInfo();
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("exit", removeInfo);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
