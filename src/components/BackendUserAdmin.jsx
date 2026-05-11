import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Input,
  message,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Timeline,
  Typography
} from 'antd';
import { BACKEND_ROLE_LABELS, BACKEND_ROLE_OPTIONS, getUserPermissions } from '../utils/accessControl';
import {
  disableAdminUser,
  enableAdminUser,
  fetchAdminUserDetail,
  fetchAdminUsers
} from '../services/adminUserApi';

const { Title, Text } = Typography;

const STATUS_LABELS = {
  active: '正常',
  disabled: '已禁用'
};

const STATUS_COLORS = {
  active: 'green',
  disabled: 'red'
};

const ACTION_LABELS = {
  'disable-user': '禁用用户',
  'enable-user': '启用用户',
  'update-user': '更新用户',
  'login-password': '密码登录',
  'login-sms': '短信登录'
};

const formatDateTime = (value) => {
  if (!value) return '--';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
};

const BackendUserAdmin = ({ currentUser }) => {
  const permissions = useMemo(() => getUserPermissions(currentUser), [currentUser]);
  const [filters, setFilters] = useState({
    q: '',
    status: '',
    backendRole: '',
    company: ''
  });
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [selectedUser, setSelectedUser] = useState(null);
  const [busyUserId, setBusyUserId] = useState(null);
  const [messageApi, contextHolder] = message.useMessage();

  const loadUsers = async () => {
    if (!permissions.viewBackendUserAdmin) return;
    setLoading(true);
    try {
      const payload = await fetchAdminUsers(filters, currentUser);
      setUsers(payload.items || []);
    } catch (error) {
      messageApi.error(error?.message || '加载后台用户列表失败。');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    filters.q,
    filters.status,
    filters.backendRole,
    filters.company,
    permissions.viewBackendUserAdmin
  ]);

  const companyOptions = useMemo(() => {
    return [...new Set(users.map((item) => String(item.company || '').trim()).filter(Boolean))].map((value) => ({
      label: value,
      value
    }));
  }, [users]);

  const openDetail = async (record) => {
    setDetailLoading(true);
    setDetailOpen(true);
    try {
      const payload = await fetchAdminUserDetail(record.id, currentUser);
      setSelectedUser(payload.user || null);
    } catch (error) {
      messageApi.error(error?.message || '加载用户详情失败。');
      setDetailOpen(false);
    } finally {
      setDetailLoading(false);
    }
  };

  const handleToggleStatus = async (record) => {
    if (!permissions.disableUser) {
      messageApi.warning('当前角色没有启用或禁用用户的权限。');
      return;
    }

    setBusyUserId(record.id);
    try {
      if (record.status === 'disabled') {
        await enableAdminUser(record.id, currentUser);
        messageApi.success(`已启用用户 ${record.name}。`);
      } else {
        await disableAdminUser(record.id, currentUser);
        messageApi.success(`已禁用用户 ${record.name}。`);
      }
      await loadUsers();
      if (selectedUser?.id === record.id) {
        const payload = await fetchAdminUserDetail(record.id, currentUser);
        setSelectedUser(payload.user || null);
      }
    } catch (error) {
      messageApi.error(error?.message || '更新用户状态失败。');
    } finally {
      setBusyUserId(null);
    }
  };

  const columns = [
    {
      title: '账号',
      dataIndex: 'account',
      key: 'account',
      width: 140
    },
    {
      title: '姓名',
      dataIndex: 'name',
      key: 'name',
      width: 120
    },
    {
      title: '公司',
      dataIndex: 'company',
      key: 'company',
      ellipsis: true
    },
    {
      title: '手机号',
      dataIndex: 'phone',
      key: 'phone',
      width: 150
    },
    {
      title: '后台角色',
      dataIndex: 'backend_role',
      key: 'backend_role',
      width: 160,
      render: (value) => <Tag color="blue">{BACKEND_ROLE_LABELS[value] || value}</Tag>
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (value) => <Tag color={STATUS_COLORS[value] || 'default'}>{STATUS_LABELS[value] || value}</Tag>
    },
    {
      title: '最近登录',
      dataIndex: 'last_login_at',
      key: 'last_login_at',
      width: 180,
      render: (value) => formatDateTime(value)
    },
    {
      title: '操作',
      key: 'actions',
      width: 200,
      render: (_, record) => (
        <Space>
          <Button onClick={() => openDetail(record)}>
            查看详情
          </Button>
          <Button
            danger={record.status !== 'disabled'}
            type={record.status === 'disabled' ? 'default' : 'primary'}
            loading={busyUserId === record.id}
            disabled={!permissions.disableUser}
            onClick={() => handleToggleStatus(record)}
          >
            {record.status === 'disabled' ? '启用' : '禁用'}
          </Button>
        </Space>
      )
    }
  ];

  if (!permissions.viewBackendUserAdmin) {
    return <Alert type="warning" message="当前账号没有后台用户管理权限。" showIcon />;
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {contextHolder}
      <Card bordered={false}>
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
            <div>
              <Title level={3} style={{ margin: 0 }}>后台用户管理</Title>
              <Text type="secondary">
                查看用户列表、用户详情、登录日志和管理员操作日志。
              </Text>
            </div>
            <Button onClick={loadUsers}>刷新</Button>
          </div>

          <Row gutter={16}>
            <Col span={6}>
              <Statistic title="用户总数" value={users.length} />
            </Col>
            <Col span={6}>
              <Statistic title="正常用户" value={users.filter((item) => item.status !== 'disabled').length} />
            </Col>
            <Col span={6}>
              <Statistic title="已禁用用户" value={users.filter((item) => item.status === 'disabled').length} />
            </Col>
            <Col span={6}>
              <Statistic title="公司数" value={companyOptions.length} />
            </Col>
          </Row>

          <Space wrap size={12}>
            <Input.Search
              allowClear
              placeholder="搜索账号 / 姓名 / 手机号 / 公司"
              style={{ width: 320 }}
              onSearch={(value) => setFilters((prev) => ({ ...prev, q: value }))}
              onChange={(event) => {
                if (!event.target.value) {
                  setFilters((prev) => ({ ...prev, q: '' }));
                }
              }}
            />
            <Select
              allowClear
              placeholder="状态"
              style={{ width: 140 }}
              options={[
                { label: '正常', value: 'active' },
                { label: '已禁用', value: 'disabled' }
              ]}
              onChange={(value) => setFilters((prev) => ({ ...prev, status: value || '' }))}
            />
            <Select
              allowClear
              placeholder="后台角色"
              style={{ width: 200 }}
              options={BACKEND_ROLE_OPTIONS.map((item) => ({
                label: BACKEND_ROLE_LABELS[item.value] || item.value,
                value: item.value
              }))}
              onChange={(value) => setFilters((prev) => ({ ...prev, backendRole: value || '' }))}
            />
            <Select
              allowClear
              placeholder="公司"
              style={{ width: 220 }}
              options={companyOptions}
              onChange={(value) => setFilters((prev) => ({ ...prev, company: value || '' }))}
            />
          </Space>

          <Table
            rowKey="id"
            loading={loading}
            columns={columns}
            dataSource={users}
            pagination={{ pageSize: 10, showSizeChanger: false }}
            scroll={{ x: 1200 }}
          />
        </Space>
      </Card>

      <Drawer
        width={760}
        title={selectedUser ? `用户详情 · ${selectedUser.name}` : '用户详情'}
        open={detailOpen}
        onClose={() => {
          setDetailOpen(false);
          setSelectedUser(null);
        }}
        destroyOnClose
      >
        {detailLoading || !selectedUser ? (
          <Card loading />
        ) : (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Descriptions bordered column={2} size="small">
              <Descriptions.Item label="账号">{selectedUser.account}</Descriptions.Item>
              <Descriptions.Item label="姓名">{selectedUser.name}</Descriptions.Item>
              <Descriptions.Item label="公司">{selectedUser.company}</Descriptions.Item>
              <Descriptions.Item label="手机号">{selectedUser.phone}</Descriptions.Item>
              <Descriptions.Item label="邮箱">{selectedUser.email || '--'}</Descriptions.Item>
              <Descriptions.Item label="后台角色">
                <Tag color="blue">
                  {BACKEND_ROLE_LABELS[selectedUser.backend_role] || selectedUser.backend_role}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="状态">
                <Tag color={STATUS_COLORS[selectedUser.status] || 'default'}>
                  {STATUS_LABELS[selectedUser.status] || selectedUser.status}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="Token 版本">{selectedUser.token_version}</Descriptions.Item>
              <Descriptions.Item label="最近登录">{formatDateTime(selectedUser.last_login_at)}</Descriptions.Item>
              <Descriptions.Item label="创建时间">{formatDateTime(selectedUser.created_at)}</Descriptions.Item>
              <Descriptions.Item label="禁用时间">{formatDateTime(selectedUser.disabled_at)}</Descriptions.Item>
            </Descriptions>

            <Card title="登录日志" size="small">
              <Timeline
                items={(selectedUser.recent_login_logs || []).map((item) => ({
                  color: item.login_status === 'success' ? 'green' : 'red',
                  children: (
                    <div>
                      <div style={{ fontWeight: 600 }}>
                        {ACTION_LABELS[`login-${item.login_type}`] || item.login_type}
                      </div>
                      <div>{formatDateTime(item.created_at)}</div>
                      <div style={{ color: '#64748b' }}>
                        IP：{item.ip_address || '--'} · Token 版本：{item.token_version}
                      </div>
                    </div>
                  )
                }))}
              />
            </Card>

            <Card title="管理员操作日志" size="small">
              <Timeline
                items={(selectedUser.recent_admin_operation_logs || []).map((item) => ({
                  color: item.action === 'disable-user' ? 'red' : 'blue',
                  children: (
                    <div>
                      <div style={{ fontWeight: 600 }}>{ACTION_LABELS[item.action] || item.action}</div>
                      <div>{formatDateTime(item.created_at)}</div>
                      <div style={{ color: '#64748b' }}>{item.detail}</div>
                    </div>
                  )
                }))}
              />
            </Card>
          </Space>
        )}
      </Drawer>
    </div>
  );
};

export default BackendUserAdmin;
