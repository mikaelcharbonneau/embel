import Image from "next/image";

/** The user-approved mark from Wonder concept 22 (a clean copy; the original file with its provenance record is
 * design-assets/brand/embel-mark-original.svg). It is on the first screen of every page, so it loads eagerly. */
export function AppMark() {
  return <Image src="/embel-mark.svg" width={28} height={28} alt="" aria-hidden="true" loading="eager" unoptimized />;
}
