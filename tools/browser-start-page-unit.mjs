import assert from "node:assert/strict";
import { isBrowserStartPageUrl } from "../src/components/BrowserStartPage.tsx";

assert.equal(isBrowserStartPageUrl(""), true);
assert.equal(isBrowserStartPageUrl("about:blank"), true);
assert.equal(isBrowserStartPageUrl("https://www.google.com/"), true);
assert.equal(isBrowserStartPageUrl("https://google.com/"), true);
assert.equal(isBrowserStartPageUrl("https://www.google.com/webhp"), true);
assert.equal(isBrowserStartPageUrl("https://www.google.com/search?q=mutex"), false);
assert.equal(isBrowserStartPageUrl("https://github.com/"), false);
assert.equal(isBrowserStartPageUrl("http://127.0.0.1:3000/api/openbrowser/new-tab"), true);

console.log("browser-start-page-url: ok");
