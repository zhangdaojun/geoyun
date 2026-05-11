const DB_NAME = 'geoyun_file_blob_store';
const STORE_NAME = 'uploaded_files';
const DB_VERSION = 1;

const openDb = () => new Promise((resolve, reject) => {
  const request = window.indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(STORE_NAME)) {
      db.createObjectStore(STORE_NAME, { keyPath: 'id' });
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

/**
 * 在 readwrite 事务里调用 handler 写入数据；返回的 Promise 只在 **事务整体**
 * 提交成功（transaction.oncomplete）后才 resolve；这样 `await saveFileBlob`
 * 之后立刻 `loadFileBlob` 才能保证读到刚写入的内容。原实现在 put 的
 * `onsuccess` 时就 resolve，事务后续若 abort 错误会被静默吞掉。
 */
const runReadWrite = async (handler) => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let payload;
    let collected = false;
    let aborted = false;
    try {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      handler(store, (result) => {
        payload = result;
        collected = true;
      }, (error) => {
        aborted = true;
        try { transaction.abort(); } catch { /* ignore */ }
        reject(error);
      });
      transaction.oncomplete = () => {
        db.close();
        if (!aborted) resolve(collected ? payload : true);
      };
      transaction.onerror = () => {
        db.close();
        if (!aborted) reject(transaction.error || new Error('IndexedDB transaction failed'));
      };
      transaction.onabort = () => {
        db.close();
        if (!aborted) reject(transaction.error || new Error('IndexedDB transaction aborted'));
      };
    } catch (err) {
      try { db.close(); } catch { /* ignore */ }
      reject(err);
    }
  });
};

const runReadOnly = async (handler) => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    try {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      handler(store, resolve, reject);
      transaction.onerror = () => reject(transaction.error);
      transaction.oncomplete = () => db.close();
    } catch (err) {
      try { db.close(); } catch { /* ignore */ }
      reject(err);
    }
  });
};

export const saveFileBlob = async ({ id, name, type, blob }) => {
  if (!id || !blob) return;
  return runReadWrite((store, _resolve, reject) => {
    const request = store.put({ id, name, type, blob, updatedAt: Date.now() });
    request.onerror = () => reject(request.error);
  });
};

export const loadFileBlob = async (id) => {
  if (!id) return null;
  return runReadOnly((store, resolve, reject) => {
    const request = store.get(id);
    request.onsuccess = () => {
      const result = request.result;
      if (!result?.blob) {
        resolve(null);
        return;
      }
      resolve(new File([result.blob], result.name || id, { type: result.type || result.blob.type || 'application/octet-stream' }));
    };
    request.onerror = () => reject(request.error);
  });
};

export const deleteFileBlobs = async (ids = []) => {
  const targetIds = ids.filter(Boolean);
  if (!targetIds.length) return;
  return runReadWrite((store) => {
    targetIds.forEach((id) => {
      store.delete(id);
    });
  });
};

export const getAllFileBlobs = async () => {
  return runReadOnly((store, resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
};

/**
 * 按文件名兜底查询 IndexedDB（用于主键 persistedBlobId 在持久化往返过程
 * 中丢失的情况）。返回最近一次 updatedAt 最大的匹配项，找不到返回 null。
 */
export const findFileBlobByName = async (name) => {
  if (!name) return null;
  const records = await getAllFileBlobs().catch(() => []);
  const target = String(name).trim().toLowerCase();
  const candidates = records.filter((record) => (
    record?.blob && String(record?.name || '').trim().toLowerCase() === target
  ));
  if (!candidates.length) return null;
  candidates.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const best = candidates[0];
  return new File(
    [best.blob],
    best.name || name,
    { type: best.type || best.blob.type || 'application/octet-stream' },
  );
};

export const clearAllFileBlobs = async () => {
  return runReadWrite((store, _resolve, reject) => {
    const request = store.clear();
    request.onerror = () => reject(request.error);
  });
};
