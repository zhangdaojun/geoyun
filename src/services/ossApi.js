import { buildQueryString, requestAdminApi } from './apiClient';

export const getOssUploadPolicy = async (projectId, fileName) => (
  requestAdminApi(
    `/oss/upload-policy${buildQueryString({
      project_id: projectId,
      file_name: fileName,
    })}`,
    null,
    { method: 'GET' }
  )
);

export const getOssDownloadUrl = async (objectKey) => {
  const result = await requestAdminApi(
    `/oss/download-url${buildQueryString({ object_key: objectKey })}`,
    null,
    { method: 'GET' }
  );
  return result.url;
};

const createAbortError = () => {
  const error = new Error('upload aborted');
  error.name = 'AbortError';
  return error;
};

const isAbortError = (error) => error?.name === 'AbortError';

const uploadFileToOssOnce = (file, policyData, onProgress, signal) => {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }

    const formData = new FormData();
    formData.append('key', policyData.dir);
    formData.append('policy', policyData.policy);
    formData.append('OSSAccessKeyId', policyData.accessid);
    formData.append('success_action_status', '200');
    formData.append('signature', policyData.signature);
    formData.append('file', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', policyData.host, true);

    const cleanupAbortListener = () => {
      signal?.removeEventListener?.('abort', handleAbort);
    };

    const handleAbort = () => {
      xhr.abort();
    };

    signal?.addEventListener?.('abort', handleAbort, { once: true });

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        const percent = Math.round((event.loaded / event.total) * 100);
        onProgress(percent);
      }
    };

    xhr.onload = () => {
      cleanupAbortListener();
      if (xhr.status === 200 || xhr.status === 204) {
        resolve();
      } else {
        reject(new Error(`OSS upload failed, HTTP status: ${xhr.status}`));
      }
    };

    xhr.onerror = () => {
      cleanupAbortListener();
      reject(new Error('OSS upload network error'));
    };

    xhr.onabort = () => {
      cleanupAbortListener();
      reject(createAbortError());
    };

    xhr.send(formData);
  });
};

export const uploadFileToOss = async (file, policyData, onProgress, options = {}) => {
  const maxAttempts = 2;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await uploadFileToOssOnce(file, policyData, onProgress, options.signal);
      return;
    } catch (error) {
      lastError = error;
      if (isAbortError(error)) break;
      if (attempt >= maxAttempts) break;
    }
  }

  throw lastError || new Error('OSS upload failed');
};
