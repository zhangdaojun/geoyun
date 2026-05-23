import { useMemo, useState } from 'react';
import { updateProjectWithCloudItems } from '../../../utils/projectModel';

const mergeDriveFileItem = (localItem = {}, remoteItem = {}) => {
  const merged = {
    ...localItem,
    ...remoteItem
  };
  const localPersistedBlobId = localItem.persistedBlobId || localItem.persisted_blob_id;
  const remotePersistedBlobId = remoteItem.persistedBlobId || remoteItem.persisted_blob_id;
  if (!remotePersistedBlobId && localPersistedBlobId) {
    merged.persistedBlobId = localPersistedBlobId;
    merged.persisted_blob_id = localPersistedBlobId;
  }

  const localObjectKey = localItem.object_key || localItem.objectKey;
  const remoteObjectKey = remoteItem.object_key || remoteItem.objectKey;
  if (!remoteObjectKey && localObjectKey) {
    merged.object_key = localObjectKey;
    merged.objectKey = localObjectKey;
  }

  const remoteStorageProvider = remoteItem.storage_provider || remoteItem.storageProvider;
  if (localPersistedBlobId && remoteStorageProvider === 'oss' && !remoteObjectKey) {
    merged.storage_provider = localItem.storage_provider || localItem.storageProvider || 'indexeddb';
    merged.storageProvider = merged.storage_provider;
  }

  return merged;
};

const getIterationIndexFromName = (name = '') => {
  const match = String(name || '').match(/^iteration_(\d{3})(?:_|\.|$)/i);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isFinite(index) ? index : null;
};

const getIterationFolderName = (index) => (
  Number(index) === 0 ? '初始模型' : `第 ${Number(index)} 次迭代`
);

const groupFlatIterationFiles = (items = []) => {
  const folderByParentAndName = new Map();
  items.forEach((item) => {
    if (item?.type !== 'folder') return;
    folderByParentAndName.set(`${item.parentId || ''}\u001f${item.name || ''}`, item);
  });

  return items.map((item) => {
    if (item?.type !== 'file') return item;
    const iterationIndex = getIterationIndexFromName(item.name);
    if (!Number.isFinite(iterationIndex)) return item;
    const folderName = getIterationFolderName(iterationIndex);
    const folder = folderByParentAndName.get(`${item.parentId || ''}\u001f${folderName}`);
    if (!folder?.id || item.parentId === folder.id) return item;
    return {
      ...item,
      parentId: folder.id,
      iterationIndex
    };
  });
};

export const useDriveItems = ({
  localFileSystem,
  backendFolderItems,
  backendFileItems,
  shouldUseAdminFolders,
  shouldLogFileOperations,
  latestProjectRef,
  latestFileSystemRef,
  onUpdateProject,
  currentUser,
  suppressedDriveItemIds
}) => {
  const [optimisticState, setOptimisticState] = useState(null);

  const normalizedLocalItems = useMemo(
    () => {
      if (optimisticState?.source === localFileSystem && Array.isArray(optimisticState.items)) {
        return optimisticState.items;
      }
      return Array.isArray(localFileSystem) ? localFileSystem : [];
    },
    [localFileSystem, optimisticState]
  );

  const fileSystem = useMemo(() => {
    const suppressedIds = suppressedDriveItemIds instanceof Set ? suppressedDriveItemIds : new Set();
    const isSuppressed = (item) => item?.id && suppressedIds.has(String(item.id));
    const normalizedRemoteFolderItems = Array.isArray(backendFolderItems) ? backendFolderItems : [];
    const normalizedRemoteItems = Array.isArray(backendFileItems) ? backendFileItems : [];
    const remoteFolderByExternalId = new Map(
      (shouldUseAdminFolders ? normalizedRemoteFolderItems : [])
        .filter((item) => item?.id)
        .filter((item) => !isSuppressed(item))
        .map((item) => [String(item.id), item])
    );
    const remoteByExternalId = new Map(
      (shouldLogFileOperations ? normalizedRemoteItems : [])
        .filter((item) => item?.id)
        .filter((item) => !isSuppressed(item))
        .map((item) => [String(item.id), item])
    );

    const nextFileSystem = normalizedLocalItems.map((item) => {
      if (isSuppressed(item)) return null;
      if (item?.type === 'folder') {
        const matchedFolderItem = remoteFolderByExternalId.get(String(item.id));
        if (!matchedFolderItem) return item;
        remoteFolderByExternalId.delete(String(item.id));
        return {
          ...item,
          ...matchedFolderItem
        };
      }

      if (item?.type !== 'file') return item;

      const candidateIds = [item.id]
        .filter(Boolean)
        .map((value) => String(value));
      const matchedRemoteItem = candidateIds
        .map((candidateId) => remoteByExternalId.get(candidateId))
        .find(Boolean);

      if (!matchedRemoteItem) return item;

      remoteByExternalId.delete(String(matchedRemoteItem.id));
      return mergeDriveFileItem(item, matchedRemoteItem);
    }).filter(Boolean);

    remoteFolderByExternalId.forEach((item) => nextFileSystem.push(item));
    remoteByExternalId.forEach((item) => nextFileSystem.push(item));
    return groupFlatIterationFiles(nextFileSystem);
  }, [
    backendFileItems,
    backendFolderItems,
    normalizedLocalItems,
    shouldLogFileOperations,
    shouldUseAdminFolders,
    suppressedDriveItemIds
  ]);

  const setFileSystem = async (next, options = {}) => {
    const project = latestProjectRef.current;
    if (!project || !onUpdateProject) return;
    const {
      syncSource,
      syncTitle,
      syncDetail,
      syncedTitle,
      syncedDetail,
      errorTitle,
      errorDetail,
      waitForSync = true,
      silentSync = false,
      ...projectUpdateOptions
    } = options || {};
    const nextItems = typeof next === 'function' ? next(latestFileSystemRef.current || []) : next;
    const nextProject = updateProjectWithCloudItems(project, nextItems, {
      ...projectUpdateOptions,
      actor: currentUser
    });
    latestFileSystemRef.current = nextItems;
    latestProjectRef.current = nextProject;
    setOptimisticState({ source: localFileSystem, items: nextItems });
    const syncMeta = syncSource && !silentSync
      ? {
          syncSource,
          syncTitle,
          syncDetail,
          syncedTitle,
          syncedDetail,
          errorTitle,
          errorDetail,
          skipRefetch: true
        }
      : {};
    const syncPromise = onUpdateProject(nextProject, syncMeta)
      .then((savedProject) => {
        setOptimisticState(null);
        return savedProject;
      })
      .catch((error) => {
        setOptimisticState(null);
        latestProjectRef.current = project;
        latestFileSystemRef.current = fileSystem;
        throw error;
      });

    if (!waitForSync) {
      syncPromise.catch((error) => {
        console.warn('Failed to sync drive items to project backend', error);
      });
      return nextProject;
    }

    return syncPromise;
  };

  return {
    normalizedLocalItems,
    fileSystem,
    setFileSystem
  };
};
