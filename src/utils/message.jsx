import { message, Modal } from 'antd';

/**
 * Unified messaging utilities wrapping Ant Design components.
 * Replaces window.alert / window.confirm / window.prompt throughout the app.
 */

export const msg = {
  success: (text) => message.success(text),
  error: (text) => message.error(text),
  warn: (text) => message.warning(text),
  info: (text) => message.info(text),
  loading: (text) => message.loading(text),
};

/**
 * Replacement for window.confirm.
 * Returns a Promise<boolean>.
 */
export const confirmDialog = (title, content) => {
  return new Promise((resolve) => {
    Modal.confirm({
      title,
      content,
      okText: '确定',
      cancelText: '取消',
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
};

/**
 * Three-way choice dialog for workflows such as duplicate uploads.
 * Returns the selected choice value, or null when dismissed.
 */
export const choiceDialog = ({ title, content, choices = [] }) => {
  return new Promise((resolve) => {
    let modalRef = null;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      modalRef?.destroy?.();
      resolve(value);
    };

    modalRef = Modal.confirm({
      title,
      content: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{ lineHeight: 1.6 }}>{content}</div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', flexWrap: 'wrap' }}>
            {choices.map((choice) => (
              <button
                key={choice.value}
                type="button"
                onClick={() => finish(choice.value)}
                style={{
                  border: choice.primary ? '1px solid #1677ff' : '1px solid #d9d9d9',
                  background: choice.primary ? '#1677ff' : '#fff',
                  color: choice.primary ? '#fff' : '#1f2937',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '14px',
                  fontWeight: 500,
                  padding: '6px 14px',
                }}
              >
                {choice.label}
              </button>
            ))}
          </div>
        </div>
      ),
      okButtonProps: { style: { display: 'none' } },
      cancelButtonProps: { style: { display: 'none' } },
      onCancel: () => finish(null),
    });
  });
};

/**
 * Replacement for window.prompt.
 * Returns a Promise<string|null>.
 */
export const promptDialog = (title, defaultValue = '') => {
  return new Promise((resolve) => {
    let inputValue = defaultValue;
    Modal.confirm({
      title,
      content: (
        <input
          type="text"
          defaultValue={defaultValue}
          onChange={(e) => { inputValue = e.target.value; }}
          style={{
            width: '100%',
            padding: '8px 12px',
            borderRadius: '8px',
            border: '1px solid #d9d9d9',
            outline: 'none',
            fontSize: '14px',
            marginTop: '8px',
          }}
          autoFocus
        />
      ),
      okText: '确定',
      cancelText: '取消',
      onOk: () => resolve(inputValue?.trim() || null),
      onCancel: () => resolve(null),
    });
  });
};
