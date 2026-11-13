const cloudinary = require('cloudinary').v2;
const { ApiError } = require('../middleware/errorHandler');

function configureCloudinary() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    throw new ApiError(503, 'Video uploads are not configured on the server');
  }

  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  });
}

async function uploadVideo(filePath, publicId) {
  configureCloudinary();

  try {
    return await cloudinary.uploader.upload(filePath, {
      public_id: publicId,
      resource_type: 'video',
      type: 'authenticated',
      overwrite: false,
    });
  } catch (error) {
    console.error('[cloudinary] video upload failed:', error.message);
    throw new ApiError(502, 'Video upload to cloud storage failed');
  }
}

async function deleteVideo(publicId) {
  configureCloudinary();

  try {
    await cloudinary.uploader.destroy(publicId, {
      resource_type: 'video',
      type: 'authenticated',
      invalidate: true,
    });
  } catch (error) {
    console.error('[cloudinary] video cleanup failed:', error.message);
    throw new ApiError(502, 'Video cleanup in cloud storage failed');
  }
}

function authenticatedVideoUrl(publicId) {
  configureCloudinary();
  return cloudinary.url(publicId, {
    resource_type: 'video',
    type: 'authenticated',
    sign_url: true,
    secure: true,
    format: 'mp4',
  });
}

module.exports = { uploadVideo, deleteVideo, authenticatedVideoUrl };
