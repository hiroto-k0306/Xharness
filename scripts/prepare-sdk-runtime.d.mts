export default function prepareSdkRuntime(context: {
  packager: { info: { appDir: string } };
}): Promise<void>;
