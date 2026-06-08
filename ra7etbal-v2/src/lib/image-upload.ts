import { supabase } from "./supabase";

const BUCKET = "task-images";
const MAX_DIMENSION = 1200;
const JPEG_QUALITY = 0.82;
const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15 MB hard limit before resize

/**
 * Resize an image file to at most MAX_DIMENSION px on the longest edge,
 * then return a JPEG blob. Runs entirely in the browser via canvas.
 */
export async function resizeImage(file: File): Promise<Blob> {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(
      `Image is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Please choose a photo under 15 MB.`,
    );
  }

  return new Promise<Blob>((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);

      const { width, height } = img;
      let targetW = width;
      let targetH = height;

      if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
        if (width >= height) {
          targetW = MAX_DIMENSION;
          targetH = Math.round((height / width) * MAX_DIMENSION);
        } else {
          targetH = MAX_DIMENSION;
          targetW = Math.round((width / height) * MAX_DIMENSION);
        }
      }

      const canvas = document.createElement("canvas");
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Could not get canvas context."));
        return;
      }
      ctx.drawImage(img, 0, 0, targetW, targetH);
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error("Could not convert image to JPEG."));
            return;
          }
          resolve(blob);
        },
        "image/jpeg",
        JPEG_QUALITY,
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Could not load image. Please try a different file."));
    };

    img.src = objectUrl;
  });
}

/**
 * Upload a resized image blob to Supabase Storage.
 *
 * Returns the durable storage path (not a signed URL).
 * Path format: task-images/{userId}/{taskId}/photo.jpg
 *
 * Throws if the upload fails.
 */
export async function uploadTaskImage(
  userId: string,
  taskId: string,
  blob: Blob,
): Promise<string> {
  const path = `${userId}/${taskId}/photo.jpg`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, blob, {
      contentType: "image/jpeg",
      upsert: false,
    });

  if (error) {
    throw new Error(`Image upload failed: ${error.message}`);
  }

  // Return the full bucket-prefixed path stored in tasks.image_path
  return `${BUCKET}/${path}`;
}

/**
 * Generate a short-lived signed URL from a durable image_path.
 * Used by TaskCard and HistoryCard (authenticated screens).
 *
 * path format: "task-images/{userId}/{taskId}/photo.jpg"
 * Returns null if the path is null/empty or the request fails.
 */
export async function getSignedImageUrl(
  imagePath: string | null | undefined,
  expiresInSeconds = 3600,
): Promise<string | null> {
  if (!imagePath) return null;

  // Strip the bucket prefix to get the object path inside the bucket
  const objectPath = imagePath.startsWith(`${BUCKET}/`)
    ? imagePath.slice(`${BUCKET}/`.length)
    : imagePath;

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(objectPath, expiresInSeconds);

  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}
