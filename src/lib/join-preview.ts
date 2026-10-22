import type { Metadata } from "next";

/** An invite link's preview (Open Graph): "Join <group>", with the group's photo when it has one. */
export function joinPreview(groupName: string, photo: string | undefined): Metadata {
  const title = `Join ${groupName}`;
  const images = photo ? [{ url: photo, alt: groupName }] : undefined;
  return {
    title,
    openGraph: { title, siteName: "labelmaker", type: "website", images },
    twitter: { card: "summary", title, images: photo ? [photo] : undefined },
  };
}
