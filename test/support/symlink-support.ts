import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Junctions exercise directory-link behavior without Windows developer mode.
// File links cannot be substituted: preserve the security tests where supported.
function fileSymlinkSkipReason(): false | string {
	if (process.platform !== "win32") return false;
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-symlink-probe-"));
	try {
		const target = path.join(root, "target");
		fs.writeFileSync(target, "probe");
		fs.symlinkSync(target, path.join(root, "link"), "file");
		return false;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EPERM" || code === "EACCES") return "Windows file symlinks require unavailable privilege or developer mode";
		throw error;
	} finally {
		fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
	}
}
export const fileSymlinkSkip = fileSymlinkSkipReason();
