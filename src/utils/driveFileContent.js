import { getOssDownloadUrl } from '../services/ossApi';
import { getToken } from '../services/tokenStore';
import { findFileBlobByName, loadFileBlob } from './fileBlobStore';

export const toBrowserFile = (value, fallbackName = 'data.bin') => {
  if (value instanceof File) return value;
  if (value instanceof Blob) {
    return new File([value], fallbackName || value.name || 'data.bin', {
      type: value.type || 'application/octet-stream'
    });
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return new File([value], fallbackName, { type: 'application/octet-stream' });
  }
  if (typeof value === 'string') {
    return new File([value], fallbackName || 'data.txt', { type: 'text/plain' });
  }
  return null;
};

export const resolveDriveFileContent = async (fileItem, fallbackName = 'data.bin') => {
  if (!fileItem) return null;

  const directFile = toBrowserFile(fileItem, fileItem?.name || fallbackName);
  if (directFile) return directFile;

  if (typeof fileItem.inlineTextContent === 'string') {
    return toBrowserFile(fileItem.inlineTextContent, fileItem.name || fallbackName);
  }

  const persistedBlobId = fileItem.persistedBlobId || fileItem.persisted_blob_id;
  const localBlobIds = Array.from(new Set([persistedBlobId, fileItem.id].filter(Boolean).map(String)));
  for (const localBlobId of localBlobIds) {
    const persistedFile = await loadFileBlob(localBlobId);
    if (persistedFile) return persistedFile;
  }
  if (fileItem.name || fallbackName) {
    const namedFile = await findFileBlobByName(fileItem.name || fallbackName).catch(() => null);
    if (namedFile) return namedFile;
  }

  if (fileItem.fileUrl) {
    const remoteFile = await fetchDriveFileUrl(fileItem.fileUrl, fileItem.name || fallbackName).catch(() => null);
    if (remoteFile) return remoteFile;
  }

  const objectKey = fileItem.object_key || fileItem.objectKey;
  const isOssFile = objectKey && (
    fileItem.storage_provider === 'oss' || fileItem.storageProvider === 'oss'
  );
  if (!isOssFile) {
    return fetchLocalErtInputFile(fileItem.name || fallbackName).catch(() => null);
  }

  const downloadUrl = await getOssDownloadUrl(objectKey).catch(() => null);
  if (downloadUrl) {
    const response = await fetch(downloadUrl).catch(() => null);
    if (response?.ok) {
      const blob = await response.blob();
      return toBrowserFile(blob, fileItem.name || fallbackName);
    }
  }

  const localErtFile = await fetchLocalErtInputFile(fileItem.name || fallbackName).catch(() => null);
  if (localErtFile) return localErtFile;
  throw new Error('Failed to download OSS file');
};

export const fetchDriveFileUrl = async (fileUrl, fallbackName = 'data.bin') => {
  const token = getToken();
  const response = await fetch(fileUrl, {
    credentials: String(fileUrl || '').startsWith('/') ? 'include' : 'omit',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) {
    throw new Error(`Failed to download file URL: ${response.status}`);
  }
  return toBrowserFile(await response.blob(), fallbackName);
};

export const fetchLocalErtInputFile = async (fileName = 'data.dat') => {
  const safeName = String(fileName || 'data.dat').split(/[\\/]/).pop();
  if (!/\.(dat|shm|txt|csv|xyz|npz)$/i.test(safeName)) return null;
  const token = getToken();
  const response = await fetch(`/admin/ert/local-input-files/${encodeURIComponent(safeName)}`, {
    credentials: 'include',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) return null;
  return toBrowserFile(await response.blob(), safeName);
};
