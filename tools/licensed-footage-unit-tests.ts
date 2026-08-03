import assert from "node:assert/strict";
import {
  createLicensedFootageService,
  FootageSearchValidationError,
  normalisePexelsVideo,
  normalisePixabayVideo,
  normaliseWikimediaVideo,
  validateFootageSearchInput,
} from "../lib/clipper/licensed-footage";

let assertions = 0;
function check(value: unknown, message?: string): asserts value {
  assert.ok(value, message);
  assertions += 1;
}

const wikimediaVideo = normaliseWikimediaVideo({
  pageid: 42,
  title: "File:City lights.webm",
  fullurl: "https://commons.wikimedia.org/wiki/File:City_lights.webm",
  imageinfo: [{
    url: "https://upload.wikimedia.org/example/city-lights.webm",
    thumburl: "https://upload.wikimedia.org/example/city-lights-thumb.jpg",
    descriptionurl: "https://commons.wikimedia.org/wiki/File:City_lights.webm",
    mime: "video/webm",
    width: 1920,
    height: 1080,
    size: 123456,
    extmetadata: {
      LicenseShortName: { value: "CC BY-SA 4.0" },
      LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0/" },
      Artist: { value: "Example creator" },
      ObjectName: { value: "City lights" },
    },
  }],
});
check(wikimediaVideo);
assert.equal(wikimediaVideo.provider, "wikimedia"); assertions += 1;
assert.equal(wikimediaVideo.licenceName, "CC BY-SA 4.0"); assertions += 1;
assert.equal(wikimediaVideo.attributionRequired, true); assertions += 1;
assert.equal(wikimediaVideo.mimeType, "video/webm"); assertions += 1;

assert.equal(normaliseWikimediaVideo({
  pageid: 43,
  title: "File:Unknown.mov",
  imageinfo: [{
    url: "https://upload.wikimedia.org/example/unknown.mov",
    descriptionurl: "https://commons.wikimedia.org/wiki/File:Unknown.mov",
    mime: "video/quicktime",
    extmetadata: { LicenseShortName: { value: "All rights reserved" } },
  }],
}), null);
assertions += 1;

const rawPexelsVideo = {
  id: 101,
  url: "https://www.pexels.com/video/101/",
  image: "https://images.pexels.com/videos/101/preview.jpg",
  duration: 12,
  width: 3840,
  height: 2160,
  user: { name: "Pexels Creator", url: "https://www.pexels.com/@creator" },
  video_files: [{
    link: "https://videos.pexels.com/video-files/101/source.mp4",
    quality: "hd",
    file_type: "video/mp4",
    width: 1920,
    height: 1080,
    fps: 30,
  }],
};
const pexelsVideo = normalisePexelsVideo(rawPexelsVideo);
check(pexelsVideo);
assert.equal(pexelsVideo.licenceName, "Pexels License"); assertions += 1;
assert.equal(pexelsVideo.licenceConfidence, "provider-declared"); assertions += 1;
assert.equal(pexelsVideo.attributionRequired, false); assertions += 1;
assert.equal(normalisePexelsVideo({
  ...{
    id: 102,
    url: "https://www.pexels.com/video/102/",
    video_files: [{ link: "https://videos.pexels.com/video-files/102/source.mp4" }],
  },
  license: "All rights reserved",
}), null);
assertions += 1;

const rawPixabayVideo = {
  id: 202,
  pageURL: "https://pixabay.com/videos/example-202/",
  tags: "cloud computing, server room",
  duration: 9,
  user: "Pixabay Creator",
  user_id: 12,
  videos: { large: { url: "https://cdn.pixabay.com/video/202.mp4", width: 1920, height: 1080, size: 456789 } },
};
const pixabayVideo = normalisePixabayVideo(rawPixabayVideo);
check(pixabayVideo);
assert.equal(pixabayVideo.licenceName, "Pixabay Content License"); assertions += 1;
assert.equal(pixabayVideo.title, "cloud computing"); assertions += 1;
assert.equal(pixabayVideo.sourceMetadata.fileSizeBytes, 456789); assertions += 1;

assert.throws(() => validateFootageSearchInput({ query: "x" }), FootageSearchValidationError);
assertions += 1;
assert.throws(() => validateFootageSearchInput({ query: "good", providers: ["not-a-provider" as never] }), FootageSearchValidationError);
assertions += 1;

const responseFor = (payload: unknown) => new Response(JSON.stringify(payload), {
  status: 200,
  headers: { "content-type": "application/json" },
});
const requests: URL[] = [];
const fixtureFetch: typeof fetch = async (input) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
  requests.push(url);
  if (url.hostname === "commons.wikimedia.org") {
    return responseFor({ query: { pages: [{
      pageid: 99,
      title: "File:Fixture.webm",
      imageinfo: [{
        url: "https://upload.wikimedia.org/fixture.webm",
        descriptionurl: "https://commons.wikimedia.org/wiki/File:Fixture.webm",
        mime: "video/webm",
        extmetadata: { LicenseShortName: { value: "CC BY 4.0" } },
      }],
    }] } });
  }
  if (url.hostname === "api.pexels.com") return responseFor({ videos: [rawPexelsVideo] });
  if (url.hostname === "pixabay.com") return responseFor({ hits: [rawPixabayVideo] });
  return new Response("not found", { status: 404 });
};

const noKeyService = createLicensedFootageService({ env: {}, fetchImpl: fixtureFetch });
const noKeyResult = await noKeyService.search({ query: "city lights" });
assert.equal(noKeyResult.results.find((item) => item.provider === "wikimedia")?.assets.length, 1); assertions += 1;
assert.equal(noKeyResult.results.find((item) => item.provider === "pexels")?.code, "provider_not_configured"); assertions += 1;
assert.equal(noKeyResult.results.find((item) => item.provider === "pixabay")?.state, "unavailable"); assertions += 1;
assert.equal(requests.some((url) => url.hostname === "api.pexels.com"), false); assertions += 1;
assert.equal(requests.some((url) => url.hostname === "pixabay.com"), false); assertions += 1;

requests.length = 0;
const keyedService = createLicensedFootageService({
  env: { PEXELS_API_KEY: "pexels-test-secret", PIXABAY_API_KEY: "pixabay-test-secret" },
  fetchImpl: fixtureFetch,
});
const keyedResult = await keyedService.search({ query: "city lights", providers: ["pexels", "pixabay"] });
assert.equal(keyedResult.results.every((item) => item.state === "available"), true); assertions += 1;
assert.equal(keyedResult.results.reduce((count, item) => count + item.assets.length, 0), 2); assertions += 1;
assert.equal(JSON.stringify(keyedResult).includes("test-secret"), false); assertions += 1;
assert.equal(requests.some((url) => url.hostname === "api.pexels.com"), true); assertions += 1;
assert.equal(requests.some((url) => url.hostname === "pixabay.com" && url.searchParams.get("key") === "pixabay-test-secret"), true); assertions += 1;

console.log(`licensed-footage-unit-tests: ${assertions} assertions passed`);
