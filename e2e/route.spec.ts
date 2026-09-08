import { expect, test } from "@playwright/test";

// One walk through the page: a search, the result on the globe and the flat map, the
// terminal, and the page in Korean.
test("a search is drawn, read and translated", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Network route search")).toBeVisible();

  await page.getByPlaceholder("Search domain or IP").fill("gmx.net");
  await page.keyboard.press("Enter");

  const terminalToggle = page.getByRole("button", { name: "Terminal result" });
  await expect(terminalToggle).toBeVisible({ timeout: 90_000 });

  const details = page.getByRole("complementary", { name: "Route details" });
  await expect(details).toContainText("hops received");
  await expect(page.locator(".globe-host canvas")).toBeVisible();

  // The flat map is built the first time it is looked at, so its Leaflet class is the
  // proof it was; its panes are zero-sized boxes and cannot be checked for visibility.
  await page.getByRole("button", { name: "2D" }).click();
  await expect(page.locator(".packet-map-canvas.leaflet-container")).toBeVisible();

  await page.getByRole("button", { name: "3D" }).click();
  await expect(page.locator(".packet-map-canvas")).toBeHidden();

  await terminalToggle.click();
  await expect(page.getByText("Traceroute terminal")).toBeVisible();
  await expect(page.locator("main")).toContainText("gmx.net");
  await page.getByRole("button", { name: "Route map" }).click();

  await page.getByRole("button", { name: "한국어로 보기" }).click();
  await expect(page.getByRole("button", { name: "터미널 결과" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "경로 상세" })).toContainText("hop");
  await expect(page.getByRole("button", { name: "View in English" })).toBeVisible();

  await page.getByRole("button", { name: "문의" }).click();
  await expect(page.getByRole("dialog", { name: "문의" })).toContainText("heishooni@gmail.com");
  await page.getByRole("button", { name: "팀 사이트" }).click();
  await expect(page.getByRole("dialog", { name: "낭만 팀 사이트" }).getByRole("link")).toHaveAttribute("href", "https://nangman.cloud");
});
