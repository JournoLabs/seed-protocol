/**
 * The twin indexer's seed: easscan's data as of the fork (docs/local-twin-plan.md, §9).
 */
import { expect } from "chai";
import { asOfFork } from "../scripts/lib/easIndexer.js";

describe("EAS indexer seed", function () {
  it("treats revocations after the fork as not yet made, and keeps earlier ones", function () {
    const fork = 1_000;
    const [before, after, live] = asOfFork(
      [
        { id: "a", revoked: true, revocationTime: 900 },
        { id: "b", revoked: true, revocationTime: 1_100 },
        { id: "c", revoked: false, revocationTime: 0 },
      ],
      fork,
    );
    expect(before).to.include({ revoked: true, revocationTime: 900 });
    expect(after).to.include({ revoked: false, revocationTime: 0 });
    expect(live).to.include({ revoked: false, revocationTime: 0 });
  });
});
