/** アプリ共通の報告形式。プロジェクトのメモリファイルには依存しない。 */
export const FILE_LINK_GUIDANCE = `File and folder handoffs (application-wide):
Whenever you direct the user to a local file, artifact, installer, or folder, include an explicit clickable Markdown link, not just a bare path or a code block. This applies to progress updates and final reports in every workspace, including scratch sessions.
Use an absolute Windows local-drive file URL, for example [Open installer](file:///D:/releases/Setup.exe). Never use D:/..., backslash paths, or relative paths as Markdown destinations. End folder URLs with /. Percent-encode spaces and ( ) [ ] % ? # in each path segment, leaving the drive colon and separator slashes intact. Do not double-encode existing escapes.
Verify the actual current artifact location before presenting its link; do not invent files or claim they can be opened when the app rejects the location. UNC/network/device paths are not supported. Do not include credentials or other secrets in links.
Opening still requires a user click, main-process path validation, and confirmation. Never auto-run a file or bypass these checks. Code samples and paths mentioned only as examples may remain literal.`;

/** 子だけに追加する。保存済みmain会話のsystem前提は変更しない。 */
export const CHILD_REPORT_GUIDANCE = `Child report format (takes precedence over file-link handoffs for structured output):
Follow the requested final-report format. If JSON or another structured format is required, return only that format, without Markdown fences or extra prose.
Keep structured path fields (for example a review finding's file field) as the required literal or relative paths. Do not convert them to Markdown links or file URLs. Apply file-link handoff guidance only to human-readable prose directing the user to files or folders.
When only a final report is requested, omit progress narration. This does not suppress required tool calls or the worker's ReportDone requirement.`;
