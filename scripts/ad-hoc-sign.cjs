// A hook of electron-builder (`afterPack`). It gives a macOS app an ad hoc signature.
// Without a Developer ID certificate, electron-builder does not sign the app at all. Apple Silicon then reports the app as damaged.
// An ad hoc signature is not a trusted identity. The user must still open the app once with a right click and "Open".
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = function adHocSign(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }
  // With a real certificate, electron-builder signs the app itself and this hook must not get in the way.
  if (process.env.CSC_LINK || process.env.CSC_NAME) {
    return;
  }
  const app = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], {
    stdio: "inherit",
  });
  console.log(`  • ad hoc signature applied  path=${app}`);
};
