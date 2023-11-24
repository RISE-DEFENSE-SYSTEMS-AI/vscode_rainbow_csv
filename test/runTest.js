"use strict";
// This file was generated from runTests.ts file taken from vscode-extension-samples/helloworld-test-sample.
Object.defineProperty(exports, "__esModule", { value: true });
const path = require("path");
const test_electron_1 = require("@vscode/test-electron");
console.log('starting my rainbow csv tests');
async function main() {
    try {
        // The folder containing the Extension Manifest package.json
        // Passed to `--extensionDevelopmentPath`
        const extensionDevelopmentPath = path.resolve(__dirname, '../');
        const testWorkspace = path.resolve(__dirname);
        // The path to the extension test runner script
        // Passed to --extensionTestsPath
        const extensionTestsPath = path.resolve(__dirname, './suite/index');
        // Download VS Code, unzip it and run the integration test
        console.log("extensionDevelopmentPath:" + extensionDevelopmentPath + ", extensionTestsPath:" + extensionTestsPath);
        //await (0, test_electron_1.runTests)({ extensionDevelopmentPath, extensionTestsPath: extensionTestsPath, launchArgs: [testWorkspace], version: '1.83.1'});
        await (0, test_electron_1.runTests)({ extensionDevelopmentPath, extensionTestsPath: extensionTestsPath, launchArgs: [testWorkspace]});
    }
    catch (err) {
        console.error(err);
        console.error('Failed to run tests');
        process.exit(1);
    }
}
main();
//# sourceMappingURL=runTest.js.map
