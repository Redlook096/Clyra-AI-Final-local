import assert from "node:assert/strict";
import { isBrowserStartPageUrl } from "../src/components/BrowserStartPage.tsx";

assert.equal(isBrowserStartPageUrl(""), true);
assert.equal(isBrowserStartPageUrl("about:blank"), true);
assert.equal(isBrowserStartPageUrl("https://www.google.com/"), true);
assert.equal(isBrowserStartPageUrl("https://google.com/"), true);
assert.equal(isBrowserStartPageUrl("https://www.google.com/webhp"), true);
assert.equal(isBrowserStartPageUrl("https://www.google.com/search?q=mutex"), false);
assert.equal(isBrowserStartPageUrl("https://github.com/"), false);
assert.equal(isBrowserStartPageUrl("chrome-error://chromewebdata/"), true);
assert.equal(isBrowserStartPageUrl("chrome://newtab/"), true);

console.log("browser-start-page-url: ok");
