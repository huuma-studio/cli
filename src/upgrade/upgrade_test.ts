import { assertEquals } from "@std/assert";
import { supportsMinimumDependencyAgeFlag } from "./upgrade.ts";

Deno.test("supportsMinimumDependencyAgeFlag", () => {
  assertEquals(supportsMinimumDependencyAgeFlag("2.5.5"), false);
  assertEquals(supportsMinimumDependencyAgeFlag("2.5.6"), false);
  assertEquals(supportsMinimumDependencyAgeFlag("2.6.0"), false);
  assertEquals(supportsMinimumDependencyAgeFlag("2.8.0"), true);
  assertEquals(supportsMinimumDependencyAgeFlag("2.9.0"), true);
  assertEquals(supportsMinimumDependencyAgeFlag("2.9.2"), true);
  assertEquals(supportsMinimumDependencyAgeFlag("3.0.0"), true);
  assertEquals(supportsMinimumDependencyAgeFlag("2.5.4"), false);
  assertEquals(supportsMinimumDependencyAgeFlag("2.4.9"), false);
  assertEquals(supportsMinimumDependencyAgeFlag("1.46.3"), false);
  assertEquals(supportsMinimumDependencyAgeFlag("not-a-version"), false);
});
