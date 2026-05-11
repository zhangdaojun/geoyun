import { resolveFolderIdByTaskName, resolveTaskByFolderId } from '../../../utils/projectModel';
import { choiceDialog, msg } from '../../../utils/message';
import { formatFileSizeBytes } from '../../../utils/fileUtils';
import { getOssUploadPolicy, uploadFileToOss } from '../../../services/ossApi';
import {
  classifyFileInstrument,
  formatInstrumentLabel,
  getMappedDriveExt,
  isExcelWorkbookFile
} from '../driveFileRules';

const normalizeDuplicateName = (value) => String(value || '').trim().toLowerCase();

export const useDriveUploadArchive = ({
  appSettings,
  canUploadDrive,
  currentFolder,
  currentFolderId,
  fileInputRef,
  fileSystem,
  formatRestrictedInstrumentLabel = formatInstrumentLabel,
  rawFolderId,
  resolveCategoryByFolderId,
  resolveInstrumentRestrictedFolder,
  resolveUploadTargetFolderId,
  selectedProject,
  setBackendFeedback,
  setFileSystem,
  setUploadProgress,
  uploadAbortControllerRef,
  logFileOperations,
  buildFileOperationPayload,
  navigateToFolder
}) => {
  const triggerUpload = () => {
    if (!canUploadDrive) return;
    fileInputRef.current?.click();
  };

  const handleFilesUpload = async (event) => {
    const files = Array.from(event.target.files || []);
    if (!canUploadDrive) {
      event.target.value = '';
      return;
    }
    if (files.length === 0) return;

    const newFiles = [];
    const uploadedFileItems = [];
    const uploadTargets = new Set();
    const rejectedFiles = [];
    const uploadedExcelCount = files.filter(file => isExcelWorkbookFile(file.name)).length;
    const totalBytes = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
    const uploadController = new AbortController();
    const uploadSignal = uploadController.signal;
    let completedBytes = 0;
    let completedCount = 0;
    let failedCount = 0;
    let uploadStopped = false;
    let driveItemsSnapshot = Array.isArray(fileSystem) ? [...fileSystem] : [];

    if (uploadAbortControllerRef) {
      uploadAbortControllerRef.current = uploadController;
    }

    const updateUploadProgress = (patch) => {
      if (!setUploadProgress) return;
      setUploadProgress((prev) => ({
        ...(prev || {}),
        active: true,
        total: files.length,
        totalBytes,
        completed: completedCount,
        failed: failedCount,
        ...patch
      }));
    };

    const designFolderId =
      resolveFolderIdByTaskName(selectedProject, '方案规划') ||
      fileSystem.find(item => item.type === 'folder' && (
        item.category === 'design' ||
        item.taskName === '方案规划' ||
        item.name === '01_方案设计'
      ))?.id ||
      (selectedProject?.id ? `${selectedProject.id}_design` : null);

    const markCurrentFileDone = (fileSize, status = 'uploaded') => {
      completedCount += 1;
      completedBytes += fileSize;
      if (status === 'failed') failedCount += 1;
      updateUploadProgress({
        currentPercent: 100,
        uploadedBytes: completedBytes,
        status
      });
    };

    const findDuplicateFile = (parentId, fileName) => {
      const normalizedParentId = parentId || null;
      const normalizedFileName = normalizeDuplicateName(fileName);
      if (!normalizedFileName) return null;
      return driveItemsSnapshot.find((item) => (
        item?.type === 'file' &&
        (item.parentId || null) === normalizedParentId &&
        normalizeDuplicateName(item.name) === normalizedFileName &&
        item.status !== 'deleted'
      )) || null;
    };

    const resolveDuplicateUploadAction = async (existingFile, nextFile) => {
      if (!existingFile) return 'new';
      const action = await choiceDialog({
        title: '发现同名文件',
        content: `当前目录中已存在“${nextFile.name}”。请选择如何处理这次上传。`,
        choices: [
          { value: 'overwrite', label: '覆盖', primary: true },
          { value: 'keep-copy', label: '保留副本' },
          { value: 'cancel', label: '取消' },
        ],
      });
      return action || 'cancel';
    };

    const syncDriveItemsSnapshot = (validItems, replaceIds) => {
      if (!validItems.length) return;
      if (!replaceIds.size) {
        driveItemsSnapshot = [...driveItemsSnapshot, ...validItems];
        return;
      }

      const replacementById = new Map(validItems.map((item) => [item.id, item]));
      const replacedIds = new Set();
      driveItemsSnapshot = driveItemsSnapshot.map((item) => {
        if (!replacementById.has(item.id)) return item;
        replacedIds.add(item.id);
        return replacementById.get(item.id);
      });
      validItems.forEach((item) => {
        if (!replacedIds.has(item.id)) driveItemsSnapshot.push(item);
      });
    };

    const persistUploadedItems = async (items = [], fileIndex = files.length, options = {}) => {
      const validItems = items.filter(Boolean);
      if (!validItems.length) return { ok: true };
      const replaceIds = new Set(options.replaceIds || []);

      updateUploadProgress({
        currentFile: validItems[0]?.name || '',
        currentIndex: fileIndex,
        currentPercent: 100,
        uploadedBytes: completedBytes,
        status: 'syncing'
      });

      const uploadNames = validItems.map(file => file.name).join('、');
      const hasAutoOrganizedFiles = validItems.some(file => file.parentId && !currentFolderId && file.parentId !== rawFolderId);
      const copiedToDesignCount = designFolderId ? validItems.filter(file => file.parentId === designFolderId).length : 0;

      await setFileSystem(prev => {
        if (!replaceIds.size) return [...prev, ...validItems];
        const replacementById = new Map(validItems.map((item) => [item.id, item]));
        const replacedIds = new Set();
        const nextItems = prev.map((item) => {
          if (!replacementById.has(item.id)) return item;
          replacedIds.add(item.id);
          return replacementById.get(item.id);
        });
        validItems.forEach((item) => {
          if (!replacedIds.has(item.id)) nextItems.push(item);
        });
        return nextItems;
      }, {
        title: replaceIds.size ? '网盘文件已覆盖' : (hasAutoOrganizedFiles ? '网盘文件已自动归档' : '网盘文件已上传'),
        detail: `已上传 ${validItems.length} 个文件：${uploadNames}${copiedToDesignCount > 0 ? `；已同步复制到方案设计 ${copiedToDesignCount} 个文件` : ''}`,
        nodeId: 'storage',
        nodeName: '成果入库节点',
        level: 'info',
        log: true,
        syncSource: 'data-drive',
        syncTitle: '正在同步上传结果',
        syncDetail: '正在将刚上传的网盘文件写入项目数据库，并回刷测线测点树。',
        syncedTitle: '上传结果已同步',
        syncedDetail: '当前文件已写入网盘数据、项目数据库和测线测点树。',
        errorTitle: '上传结果同步失败'
      });

      const syncResult = await logFileOperations(
        validItems.map((item) => buildFileOperationPayload(
          item,
          'upload',
          {
            source: 'data-drive',
            duplicate_action: replaceIds.has(item.id) ? 'overwrite' : 'create',
          },
        ))
      );

      if (syncResult && !syncResult.ok) {
        setBackendFeedback({
          level: 'warning',
          title: '后台文件记录同步失败',
          detail: `文件已上传到 OSS 和当前网盘列表，但后台 files/file_operation_logs 写入失败：${syncResult.error?.message || '未知错误'}`
        });
      }

      syncDriveItemsSnapshot(validItems, replaceIds);
      return syncResult || { ok: true, total: validItems.length };
    };

    updateUploadProgress({
      currentFile: files[0]?.name || '',
      currentIndex: files.length > 0 ? 1 : 0,
      currentPercent: 0,
      uploadedBytes: 0,
      status: 'preparing'
    });

    const loadingMessage = msg.loading(`开始上传 ${files.length} 个文件至 OSS...`, 0);

    try {
      for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
        if (uploadSignal.aborted) {
          uploadStopped = true;
          break;
        }

        const file = files[fileIndex];
        const fileSize = Number(file.size) || 0;
        const currentIndex = fileIndex + 1;

        updateUploadProgress({
          currentFile: file.name,
          currentIndex,
          currentPercent: 0,
          uploadedBytes: completedBytes,
          status: 'preparing'
        });

        const targetFolderId = resolveUploadTargetFolderId(file.name);
        const targetTask = resolveTaskByFolderId(selectedProject, targetFolderId);
        const restrictedFolder = targetFolderId ? resolveInstrumentRestrictedFolder(targetFolderId) : null;
        const isCoordWorkbook = isExcelWorkbookFile(file.name);
        const detectedInstrumentType = classifyFileInstrument(file.name);

        if (restrictedFolder?.instrumentType && !isCoordWorkbook) {
          const allowedLabel = restrictedFolder.instrumentLabel || formatRestrictedInstrumentLabel(restrictedFolder.instrumentType);
          const matchesRestrictedInstrument = restrictedFolder.instrumentType === 'eh4-emap1'
            ? ['eh4', 'emap1'].includes(detectedInstrumentType)
            : detectedInstrumentType === restrictedFolder.instrumentType;

          if (!detectedInstrumentType) {
            rejectedFiles.push({
              fileName: file.name,
              reason: `无法识别仪器类型，目标目录仅允许 ${allowedLabel} 数据`
            });
            markCurrentFileDone(fileSize, 'failed');
            continue;
          }

          if (!matchesRestrictedInstrument) {
            rejectedFiles.push({
              fileName: file.name,
              reason: `识别为 ${formatRestrictedInstrumentLabel(detectedInstrumentType)}，目标目录仅允许 ${allowedLabel} 数据`
            });
            markCurrentFileDone(fileSize, 'failed');
            continue;
          }
        }

        if (targetFolderId) uploadTargets.add(targetFolderId);
        const mappedExt = getMappedDriveExt(file.name);
        const existingFile = findDuplicateFile(targetFolderId, file.name);
        const duplicateAction = await resolveDuplicateUploadAction(existingFile, file);
        if (duplicateAction === 'cancel') {
          rejectedFiles.push({ fileName: file.name, reason: '已取消：当前目录存在同名文件' });
          markCurrentFileDone(fileSize, 'failed');
          continue;
        }

        let policyData;
        try {
          updateUploadProgress({ status: 'policy' });
          policyData = await getOssUploadPolicy(selectedProject?.id || 0, file.name);
          if (uploadSignal.aborted) {
            uploadStopped = true;
            break;
          }
        } catch (err) {
          rejectedFiles.push({ fileName: file.name, reason: `获取上传凭证失败：${err.message}` });
          markCurrentFileDone(fileSize, 'failed');
          continue;
        }

        try {
          updateUploadProgress({ status: 'uploading' });
          await uploadFileToOss(file, policyData, (percent) => {
            const safePercent = Math.min(100, Math.max(0, Number(percent) || 0));
            updateUploadProgress({
              currentPercent: safePercent,
              uploadedBytes: completedBytes + Math.round((fileSize * safePercent) / 100),
              status: 'uploading'
            });
          }, { signal: uploadSignal });
        } catch (err) {
          if (err?.name === 'AbortError') {
            uploadStopped = true;
            updateUploadProgress({
              currentPercent: 0,
              uploadedBytes: completedBytes,
              status: 'stopped'
            });
            break;
          }
          rejectedFiles.push({ fileName: file.name, reason: `上传至 OSS 失败：${err.message}` });
          markCurrentFileDone(fileSize, 'failed');
          continue;
        }

        markCurrentFileDone(fileSize, 'uploaded');

        const buildFileItem = ({ itemId, parentId, taskName, category, status, extraFields = {} }) => ({
          id: itemId,
          parentId,
          type: 'file',
          name: file.name,
          date: new Date().toISOString(),
          size: formatFileSizeBytes(file.size),
          fileSizeBytes: file.size,
          ext: mappedExt,
          category,
          taskName,
          instrumentType: restrictedFolder?.instrumentType || detectedInstrumentType || null,
          instrumentLabel: restrictedFolder?.instrumentLabel || formatRestrictedInstrumentLabel(detectedInstrumentType),
          status,
          storage_provider: 'oss',
          object_key: policyData.dir,
          ...extraFields
        });

        const shouldOverwriteExisting = duplicateAction === 'overwrite' && existingFile;
        const itemId = shouldOverwriteExisting
          ? existingFile.id
          : 'fid_' + Math.random().toString(36).substring(7);
        const fileItem = buildFileItem({
          itemId,
          parentId: shouldOverwriteExisting ? (existingFile.parentId || null) : targetFolderId,
          taskName: targetTask?.name || currentFolder?.taskName || null,
          category: resolveCategoryByFolderId(targetFolderId),
          status: shouldOverwriteExisting ? '已覆盖' : (targetTask ? `${targetTask.name}已接收` : '已上传'),
          extraFields: shouldOverwriteExisting ? {
            backendFileId: existingFile.backendFileId || null,
          } : {},
        });

        const shouldCopyToDesign = Boolean(isCoordWorkbook && designFolderId);
        const designCopyId = shouldCopyToDesign ? 'fid_' + Math.random().toString(36).substring(7) : null;
        const designCopyItem = shouldCopyToDesign
          ? buildFileItem({
              itemId: designCopyId,
              parentId: designFolderId,
              taskName: '方案规划',
              category: resolveCategoryByFolderId(designFolderId),
              status: '方案规划已接收',
              extraFields: {
                linkedSourceFileId: itemId,
                linkedSourceFolderId: targetFolderId,
                linkedSourceTaskName: targetTask?.name || currentFolder?.taskName || null
              }
            })
          : null;

        const itemsToPersist = [fileItem, designCopyItem].filter(Boolean);

        try {
          await persistUploadedItems(itemsToPersist, currentIndex, {
            replaceIds: shouldOverwriteExisting ? [existingFile.id] : [],
          });
          uploadedFileItems.push(...itemsToPersist);
          newFiles.push(...itemsToPersist);
        } catch (err) {
          setBackendFeedback({
            level: 'warning',
            title: '网盘文件写入失败',
            detail: `${file.name} 已上传到 OSS，但写入网盘或后台记录失败：${err.message || '未知错误'}`
          });
        }
      }
    } finally {
      if (uploadAbortControllerRef?.current === uploadController) {
        uploadAbortControllerRef.current = null;
      }
      loadingMessage();
    }

    if (uploadedExcelCount > 0 && newFiles.length > 0) {
      const copiedToDesignCount = designFolderId ? newFiles.filter(file => file.parentId === designFolderId).length : 0;
      msg.warn(copiedToDesignCount > 0
        ? `已同步复制到方案设计 ${copiedToDesignCount} 个文件。`
        : '检测到 Excel 坐标文件，但未复制到方案设计目录。');
    }

    if (uploadStopped) {
      setBackendFeedback({
        level: 'warning',
        title: '上传已停止',
        detail: `已完成并写入 ${uploadedFileItems.length} 个文件，剩余文件未继续上传。`
      });
    } else if (uploadedFileItems.length > 0) {
      setBackendFeedback({
        level: 'success',
        title: '后台文件记录已逐个同步',
        detail: `已随上传进度将 ${uploadedFileItems.length} 个文件写入后台 files/file_operation_logs。`
      });
    }

    updateUploadProgress({
      active: false,
      currentFile: '',
      currentPercent: uploadStopped ? 0 : 100,
      uploadedBytes: uploadStopped ? completedBytes : totalBytes,
      status: uploadStopped ? 'stopped' : (rejectedFiles.length > 0 ? 'finished-with-errors' : 'finished')
    });

    if (!uploadStopped && !currentFolderId && uploadTargets.size === 1 && appSettings?.archiveRules?.autoOpenSingleTarget !== false) {
      navigateToFolder(Array.from(uploadTargets)[0]);
    }

    if (!uploadStopped && rejectedFiles.length > 0) {
      const groupedRejectedFiles = rejectedFiles.reduce((acc, item) => {
        if (!acc[item.reason]) acc[item.reason] = [];
        acc[item.reason].push(item.fileName);
        return acc;
      }, {});
      const summaryLines = Object.entries(groupedRejectedFiles).map(([reason, fileNames]) => {
        const previewNames = fileNames.slice(0, 5).join('、');
        const moreCount = fileNames.length - 5;
        return `- ${reason}\n  共 ${fileNames.length} 个文件：${previewNames}${moreCount > 0 ? `，另有 ${moreCount} 个` : ''}`;
      });
      msg.warn(`以下文件未上传成功（共 ${rejectedFiles.length} 个）：\n${summaryLines.join('\n')}`);
    }

    event.target.value = '';
  };

  return {
    handleFilesUpload,
    triggerUpload
  };
};
