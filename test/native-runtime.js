import { pathToFileURL } from "node:url";
import { nativeModules, nativeRuntimes } from "../scripts/test-native.mjs";

export function nativeRuntime() {
  const runtimes = nativeRuntimes();
  const version = process.env.DSH_TEST_VERSION ?? runtimes.at(-1)?.version;
  const runtime = runtimes.find((runtime) => runtime.version === version);
  if (!runtime) throw new Error(`No native test workspace for DSH ${version}.`);
  const modules = nativeModules(runtime);
  return {
    version,
    load(name) {
      const entry = modules[`@deepseek-ai/${name}`];
      if (!entry) throw new Error(`Native test module ${name} is not pinned.`);
      return import(pathToFileURL(entry).href);
    },
  };
}
