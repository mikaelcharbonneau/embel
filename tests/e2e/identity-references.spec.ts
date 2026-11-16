import { expect, test } from "@playwright/test";

// The Brand references screen is retired: the old /identity address lands on the Inspiration step, where a person's
// own images sit in the gallery ("Your images"). The reference client, its recovery rules and its previews are
// covered in tests/client/identity-references.test.ts, reference-query-stability.test.tsx,
// private-preview-stability.test.tsx and inspiration-dom-stability.test.tsx. What stays here is the address itself.
const ownerId = "40000000-0000-4000-8000-000000000001";

test("references fixture: invalid route identifiers do not read private references", async ({ page }) => {
  const requests: string[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    requests.push(`${request.method()} ${path}`);
    if (path === "/api/session") return route.fulfill({ json: { user: { id: ownerId } } });
    return route.fulfill({ status: 503, json: {} });
  });
  await page.goto("/brands/account/not-a-project/identity");
  await expect(page.getByRole("heading", { name: "Project not found" })).toBeVisible();
  // Nothing private is read or written for an address that names no project.
  expect(requests.filter((request) => /\/(?:identity|inspiration)(?:\/|$)/u.test(request))).toEqual([]);
  expect(requests.filter((request) => !request.startsWith("GET "))).toEqual([]);
});
