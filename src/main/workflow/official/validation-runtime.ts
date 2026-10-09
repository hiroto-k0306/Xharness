import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  realpath,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  writeFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, isAbsolute, dirname } from "node:path";
import { createServer, createConnection } from "node:net";
import { AppServerRpc, type AppServerPort } from "./app-server-rpc.js";
import { spawnOwnedProcess } from "./owned-process.js";
import { runtimeEnvironment } from "./workspace.js";
import { createIndependentValidator } from "./independent-validation.js";
import { WorkflowFailure } from "./contracts.js";
import type { NativeDagOptions } from "./native-dag.js";

type ClosingServer = AppServerPort & { waitClosed(): Promise<void> };
type Run = (
  program: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
) => Promise<string>;
export interface ValidationRuntimePorts {
  /** Internal fixture ports, never supplied by renderer commands. */
  platform: NodeJS.Platform;
  runOwned: Run;
  start(executable: string, cwd: string): ClosingServer;
}
export type ValidationRuntimeResult =
  | { available: false; reason: string }
  | {
      available: true;
      checkIdentity(signal: AbortSignal): Promise<void>;
      validateIntegration: NonNullable<NativeDagOptions["validateIntegration"]>;
    };
function fail(code: string): never {
  throw new WorkflowFailure(code);
}
const timeout = (signal: AbortSignal, ms = 10000) =>
  AbortSignal.any([signal, AbortSignal.timeout(ms)]);
async function fingerprint(path: string) {
  if (
    !isAbsolute(path) ||
    (await lstat(path)).isSymbolicLink() ||
    !(await lstat(path)).isFile()
  )
    fail("validation-runtime-identity-invalid");
  const actual = await realpath(path);
  if (resolve(actual).toLowerCase() !== resolve(path).toLowerCase())
    fail("validation-runtime-identity-invalid");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(actual)) hash.update(chunk);
  return hash.digest("hex");
}
const runOwned: Run = (program, args, cwd, signal) =>
  new Promise((accept, reject) => {
    const child = spawnOwnedProcess(program, args, {
      cwd,
      env: runtimeEnvironment(),
      signal,
    });
    let output = "",
      failed = false;
    let drain: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (failed) return;
      failed = true;
      child.kill();
      drain = setTimeout(
        () => reject(new WorkflowFailure("validation-cleanup-unverified")),
        3000,
      );
      drain.unref();
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (failed) return;
      output += chunk.toString();
      if (Buffer.byteLength(output) > 131072) stop();
    });
    child.stderr.resume();
    child.once("error", stop);
    child.once("close", (code) => {
      if (drain) clearTimeout(drain);
      signal.removeEventListener("abort", stop);
      if (failed || code !== 0)
        reject(new WorkflowFailure("validation-runtime-command-unavailable"));
      else accept(output);
    });
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
  });
const defaults: ValidationRuntimePorts = {
  platform: process.platform,
  runOwned,
  start: (exe, cwd) => new AppServerRpc(exe, cwd),
};
type Schema = Record<string, unknown>;
const obj = (v: unknown): Schema =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Schema) : {};
/** Require declarations for every security-sensitive field. Unknown-field acceptance is never proof. */
export function validationSchemaSupported(files: Record<string, unknown>) {
  const resolveRef = (value: unknown, file: string, depth = 0): Schema => {
    if (depth > 12) return {};
    const schema = obj(value);
    if (typeof schema.$ref !== "string") return schema;
    const [target, pointer] = schema.$ref.split("#");
    const targetFile = target
      ? join(dirname(file), target).replaceAll("\\", "/")
      : file;
    let next: unknown = files[targetFile];
    for (const segment of (pointer ?? "").split("/").filter(Boolean))
      next = obj(next)[segment.replaceAll("~1", "/").replaceAll("~0", "~")];
    return resolveRef(next, targetFile, depth + 1);
  };
  const branches = (value: unknown, file: string): Schema[] => {
    const s = resolveRef(value, file);
    const variants = s.oneOf ?? s.anyOf;
    return Array.isArray(variants)
      ? variants.flatMap((v) => branches(v, file))
      : [s];
  };
  const typed = (value: unknown, file: string, type: string) =>
    branches(value, file).some((s) => s.type === type);
  const tagged = (value: unknown, file: string, tag: string) =>
    branches(value, file).filter((s) => {
      const type = resolveRef(obj(s.properties).type, file);
      return (
        type.const === tag ||
        (Array.isArray(type.enum) && type.enum.includes(tag))
      );
    });
  const exec = Object.keys(files).find((f) =>
    /CommandExecParams\.json$/i.test(f),
  );
  const terminate = Object.keys(files).find((f) =>
    /CommandExecTerminateParams\.json$/i.test(f),
  );
  if (!exec || !terminate) return false;
  const p = obj(resolveRef(files[exec], exec).properties),
    t = obj(resolveRef(files[terminate], terminate).properties);
  if (
    !typed(p.command, exec, "array") ||
    !typed(p.cwd, exec, "string") ||
    !typed(p.processId, exec, "string") ||
    !typed(t.processId, terminate, "string") ||
    !typed(p.timeoutMs, exec, "integer") ||
    !typed(p.outputBytesCap, exec, "integer")
  )
    return false;
  const env = resolveRef(p.env, exec);
  if (
    env.type !== "object" ||
    !typed(env.additionalProperties, exec, "string") ||
    !typed(env.additionalProperties, exec, "null")
  )
    return false;
  return tagged(p.sandboxPolicy, exec, "readOnly").some((s) => {
    const policy = obj(s.properties);
    if (!typed(policy.networkAccess, exec, "boolean")) return false;
    return tagged(policy.access, exec, "restricted").some((a) => {
      const access = obj(a.properties);
      return (
        typed(access.includePlatformDefaults, exec, "boolean") &&
        typed(access.readableRoots, exec, "array")
      );
    });
  });
}
async function schemas(root: string) {
  const result: Record<string, unknown> = {};
  let bytes = 0;
  const visit = async (folder: string, prefix = "") => {
    for (const name of await readdir(folder)) {
      const path = join(folder, name),
        stat = await lstat(path),
        key = join(prefix, name).replaceAll("\\", "/");
      if (stat.isSymbolicLink()) fail("validation-schema-unverified");
      if (stat.isDirectory()) await visit(path, key);
      else if (name.endsWith(".json")) {
        bytes += stat.size;
        if (
          stat.size > 2000000 ||
          bytes > 32000000 ||
          Object.keys(result).length > 4096
        )
          fail("validation-schema-unverified");
        result[key] = JSON.parse(await readFile(path, "utf8"));
      }
    }
  };
  await visit(root);
  return result;
}
const sandbox = (cwd: string, node: string) => ({
  type: "readOnly",
  networkAccess: false,
  access: {
    type: "restricted",
    includePlatformDefaults: true,
    readableRoots: [cwd, node],
  },
});
const safeEnv = {
  NODE_OPTIONS: null,
  NODE_PATH: null,
  ELECTRON_RUN_AS_NODE: null,
};
const probeCode = String.raw`const fs=require('node:fs'),net=require('node:net');const c=JSON.parse(process.argv[1]);
const denied=f=>{try{f();return false}catch(e){return e.code==='EACCES'||e.code==='EPERM'}};
(async()=>{const inside=fs.readFileSync(c.inside,'utf8')===c.marker;
const outside=denied(()=>fs.readFileSync(c.outside));
const writeInside=denied(()=>fs.writeFileSync(c.writeInside,'synthetic'));
const writeOutside=denied(()=>fs.writeFileSync(c.writeOutside,'synthetic'));
const network=await new Promise(r=>{const s=net.createConnection({host:'127.0.0.1',port:c.port});s.once('connect',()=>{s.destroy();r(false)});s.once('error',e=>r(e.code==='EACCES'||e.code==='EPERM'));setTimeout(()=>{s.destroy();r(false)},1500).unref()});
process.stdout.write(JSON.stringify({inside,outside,writeInside,writeOutside,network}));})().catch(()=>process.exit(1));`;
const cancelCode = String.raw`const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',"process.send('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','pipe','ipc']});child.on('error',()=>process.exit(2));child.on('message',()=>process.stdout.write(process.argv[1]));child.on('exit',()=>process.exit(3));setInterval(()=>{},1000);`;
const baselineCode = String.raw`const fs=require('node:fs'),net=require('node:net');const c=JSON.parse(process.argv[1]);const read=fs.readFileSync(c.outside,'utf8')==='synthetic outside';for(const p of [c.writeInside,c.writeOutside]){fs.writeFileSync(p,'baseline');fs.unlinkSync(p)}const s=net.createConnection({host:'127.0.0.1',port:c.port});s.once('connect',()=>{s.end();process.stdout.write(JSON.stringify({read,write:true,network:true}))});s.once('error',()=>process.exit(1));setTimeout(()=>process.exit(1),1500).unref();`;
async function connect(port: number) {
  await new Promise<void>((accept, reject) => {
    const s = createConnection({ host: "127.0.0.1", port });
    s.once("connect", () => {
      s.end();
      accept();
    });
    s.once("error", reject);
    s.setTimeout(1000, () => {
      s.destroy();
      reject(Error("probe baseline"));
    });
  });
}
async function probe(
  exe: string,
  node: string,
  root: string,
  ports: ValidationRuntimePorts,
  signal: AbortSignal,
) {
  const insideRoot = join(root, "allowed");
  await mkdir(insideRoot);
  const marker = randomUUID(),
    inside = join(insideRoot, "inside.txt"),
    outside = join(root, "outside.txt");
  await writeFile(inside, marker);
  await writeFile(outside, "synthetic outside");
  const writeInside = join(insideRoot, "write.txt"),
    writeOutside = join(root, "write.txt");
  // Positive controls establish that absent files or host restrictions cannot pass a negative probe.
  if ((await readFile(outside, "utf8")) !== "synthetic outside")
    fail("validation-probe-baseline-failed");
  for (const path of [writeInside, writeOutside]) {
    await writeFile(path, "baseline");
    await rm(path);
  }
  const listener = createServer((socket) => socket.end());
  await new Promise<void>((accept, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", accept);
  });
  const port = (listener.address() as { port: number }).port;
  let server: ClosingServer | undefined;
  try {
    await connect(port);
    // The same fixed Node must also be able to start before sandbox errors are interpreted.
    const baseline = obj(
      JSON.parse(
        await ports.runOwned(
          node,
          [
            "-e",
            baselineCode,
            JSON.stringify({ outside, writeInside, writeOutside, port }),
          ],
          root,
          timeout(signal),
        ),
      ),
    );
    if (!["read", "write", "network"].every((k) => baseline[k] === true))
      fail("validation-probe-baseline-failed");
    server = ports.start(exe, insideRoot);
    server.approve(async () => {
      throw new WorkflowFailure("validation-rpc-request-refused");
    });
    await server.request(
      "initialize",
      {
        clientInfo: { name: "xharness_validation_probe", version: "0.0.0" },
        capabilities: { experimentalApi: true },
      },
      timeout(signal),
    );
    server.notify("initialized", {});
    const raw = obj(
      await server.request(
        "command/exec",
        {
          command: [
            node,
            "-e",
            probeCode,
            JSON.stringify({
              inside,
              outside,
              writeInside,
              writeOutside,
              marker,
              port,
            }),
          ],
          cwd: insideRoot,
          processId: randomUUID(),
          timeoutMs: 5000,
          outputBytesCap: 2048,
          sandboxPolicy: sandbox(insideRoot, node),
          env: safeEnv,
        },
        timeout(signal),
      ),
    );
    if (
      raw.exitCode !== 0 ||
      typeof raw.stdout !== "string" ||
      typeof raw.stderr !== "string"
    )
      fail("validation-probe-unconfirmed");
    const proof = obj(JSON.parse(raw.stdout));
    if (
      Object.keys(proof).length !== 5 ||
      !["inside", "outside", "writeInside", "writeOutside", "network"].every(
        (k) => proof[k] === true,
      )
    )
      fail("validation-isolation-unverified");
    const processId = randomUUID(),
      ready = `xh-canary-ready-${randomUUID()}`;
    const execution = server.request(
      "command/exec",
      {
        command: [node, "-e", cancelCode, ready],
        cwd: insideRoot,
        processId,
        timeoutMs: 10000,
        outputBytesCap: 2048,
        sandboxPolicy: sandbox(insideRoot, node),
        env: safeEnv,
      },
      timeout(signal),
    );
    let settled = false;
    const caught = execution.then(
      (value) => {
        settled = true;
        return { value };
      },
      () => {
        settled = true;
        return { value: undefined };
      },
    );
    await new Promise<void>((accept) => setTimeout(accept, 500));
    if (settled) fail("validation-cancel-unverified");
    await server.request(
      "command/exec/terminate",
      { processId },
      timeout(signal, 3000),
    );
    const ended = await Promise.race([
      caught,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new WorkflowFailure("validation-cancel-unverified")),
          3000,
        );
        timer.unref();
      }),
    ]);
    const result = obj(ended.value);
    if (
      !Number.isInteger(result.exitCode) ||
      result.exitCode === 0 ||
      typeof result.stdout !== "string" ||
      !result.stdout.includes(ready)
    )
      fail("validation-cancel-unverified");
  } finally {
    listener.close();
    server?.close();
    if (server)
      await Promise.race([
        server.waitClosed(),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new WorkflowFailure("validation-cleanup-unverified")),
            3000,
          );
          timer.unref();
        }),
      ]);
  }
}
/** Establish actual support without model/thread/login/setup/config RPCs. Never accepts caller-provided booleans as proof. */
export async function createValidationRuntime(options: {
  executable: string;
  nodeExecutable: string;
  signal: AbortSignal;
  ports?: ValidationRuntimePorts;
}): Promise<ValidationRuntimeResult> {
  const ports = options.ports ?? defaults;
  if (ports.platform !== "win32")
    return { available: false, reason: "validation-platform-unsupported" };
  let root: string | undefined;
  let preserve = false;
  try {
    const identity = await fingerprint(options.executable),
      nodeIdentity = await fingerprint(options.nodeExecutable);
    root = await mkdtemp(join(tmpdir(), "xh-validation-runtime-"));
    const version = (
      await ports.runOwned(
        options.executable,
        ["--version"],
        root,
        timeout(options.signal),
      )
    ).trim();
    if (
      !/^codex-cli [0-9]+\.[0-9]+\.[0-9]+(?:[-+.][A-Za-z0-9.-]+)?$/.test(
        version,
      )
    )
      fail("validation-runtime-version-unverified");
    const output = join(root, "schema");
    await ports.runOwned(
      options.executable,
      ["app-server", "generate-json-schema", "--experimental", "--out", output],
      root,
      timeout(options.signal),
    );
    if (!validationSchemaSupported(await schemas(output)))
      fail("validation-schema-unverified");
    await probe(
      options.executable,
      options.nodeExecutable,
      root,
      ports,
      options.signal,
    );
    if (
      identity !== (await fingerprint(options.executable)) ||
      nodeIdentity !== (await fingerprint(options.nodeExecutable))
    )
      fail("validation-runtime-changed");
    const checkIdentity = async (signal: AbortSignal) => {
      signal.throwIfAborted();
      if (
        identity !== (await fingerprint(options.executable)) ||
        nodeIdentity !== (await fingerprint(options.nodeExecutable))
      )
        fail("validation-runtime-changed");
      signal.throwIfAborted();
    };
    return {
      available: true,
      checkIdentity,
      validateIntegration: async (spec, cwd, signal) => {
        await checkIdentity(signal);
        let active: ClosingServer | undefined;
        const validate = createIndependentValidator({
          nodeExecutable: options.nodeExecutable,
          verifiedSandbox: {
            cliVersion: version,
            commandExec: true,
            restrictedRead: true,
            networkDenied: true,
          },
          start: (work) => {
            active = ports.start(options.executable, work);
            active.approve(async () => {
              throw new WorkflowFailure("validation-rpc-request-refused");
            });
            return active;
          },
        });
        try {
          return await validate(spec, cwd, signal);
        } finally {
          if (active) {
            active.close();
            await Promise.race([
              active.waitClosed(),
              new Promise<never>((_, reject) => {
                const timer = setTimeout(
                  () =>
                    reject(
                      new WorkflowFailure("validation-cleanup-unverified"),
                    ),
                  3000,
                );
                timer.unref();
              }),
            ]);
          }
        }
      },
    };
  } catch (error) {
    const code =
      error instanceof WorkflowFailure
        ? error.code
        : "validation-runtime-unverified";
    if (code === "validation-cleanup-unverified") {
      preserve = true;
      throw error;
    }
    return {
      available: false,
      reason: /^[a-z0-9-]{1,80}$/.test(code)
        ? code
        : "validation-runtime-unverified",
    };
  } finally {
    if (root && !preserve)
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
}
