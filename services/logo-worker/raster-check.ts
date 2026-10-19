import { qualifyCloudLogoRaster } from "./raster-qualification";

// Offline release verification only. Never loads runtime credentials or contacts
// Auth, the database, Storage or an image provider.
qualifyCloudLogoRaster(new AbortController().signal).then(() => {
  console.info(JSON.stringify({ event: "cloud_logo_raster_verified" }));
}, () => {
  console.error(JSON.stringify({ event: "cloud_logo_raster_unqualified" }));
  process.exitCode = 1;
});
