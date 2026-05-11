import React, { useEffect, useState } from 'react';
import { Building2, CloudFog, Lock, Mail, MessageCircle, Phone, ShieldCheck, User } from 'lucide-react';
import { loginWithPassword, loginWithSms, registerWithSms, sendSmsCode } from '../services/authApi';

const initialForm = {
  identifier: '',
  company: '',
  password: '',
  confirmPassword: '',
  phone: '',
  code: '',
  remember: false,
  agreed: false
};

const fieldRowStyle = {
  borderBottom: '1px solid var(--border-color)',
  display: 'flex',
  alignItems: 'center',
  padding: '8px 0'
};

const inputStyle = {
  border: 'none',
  background: 'transparent',
  outline: 'none',
  width: '100%',
  fontSize: '1rem',
  color: 'var(--text-primary)'
};

const Auth = ({ onLogin, users = [] }) => {
  const [isLogin, setIsLogin] = useState(true);
  const [loginMethod, setLoginMethod] = useState('password');
  const [formData, setFormData] = useState(initialForm);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (countdown <= 0) return undefined;
    const timer = window.setInterval(() => {
      setCountdown((value) => (value > 1 ? value - 1 : 0));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [countdown]);

  const handleChange = (event) => {
    const { name, value, type, checked } = event.target;
    setFormData((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value
    }));
    if (errorMsg) setErrorMsg('');
    if (successMsg) setSuccessMsg('');
  };

  const handleSendCode = async () => {
    if (!isLogin && !String(formData.company || '').trim()) {
      setErrorMsg('请输入公司名称后再获取验证码。');
      return;
    }
    if (!/^1[3-9]\d{9}$/.test(formData.phone)) {
      setErrorMsg('请输入正确的 11 位手机号。');
      return;
    }

    try {
      const payload = await sendSmsCode({
        phone: formData.phone,
        purpose: isLogin && loginMethod === 'mobile' ? 'login' : 'register'
      });
      setCountdown(payload.resendIn || 60);
      const debugText = payload.debugCode ? ` 调试验证码：${payload.debugCode}` : '';
      setSuccessMsg(`验证码已发送到 ${payload.phone}。${debugText}`);
    } catch (error) {
      setErrorMsg(error?.message || '验证码发送失败。');
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setErrorMsg('');
    setSuccessMsg('');

    if (!formData.agreed) {
      setErrorMsg('请先阅读并同意服务协议与隐私政策。');
      return;
    }

    setSubmitting(true);
    try {
      if (isLogin) {
        if (loginMethod === 'password') {
          if (!formData.identifier || !formData.password) {
            setErrorMsg('账号和密码不能为空。');
            return;
          }
          const payload = await loginWithPassword({
            identifier: formData.identifier,
            password: formData.password
          });
          await onLogin?.(payload.user);
          return;
        }

        if (!formData.phone || !formData.code) {
          setErrorMsg('手机号和验证码不能为空。');
          return;
        }
        const payload = await loginWithSms({
          phone: formData.phone,
          code: formData.code
        });
        await onLogin?.(payload.user);
        return;
      }

      if (!formData.identifier || !formData.company || !formData.phone || !formData.password || !formData.confirmPassword || !formData.code) {
        setErrorMsg('请完整填写注册信息。');
        return;
      }
      if (formData.password.length < 6) {
        setErrorMsg('密码长度不能少于 6 位。');
        return;
      }
      if (formData.password !== formData.confirmPassword) {
        setErrorMsg('两次输入的密码不一致。');
        return;
      }

      const payload = await registerWithSms({
        account: formData.identifier,
        name: formData.identifier,
        company: formData.company.trim(),
        phone: formData.phone,
        password: formData.password,
        code: formData.code
      });
      setSuccessMsg('注册成功，正在为你登录...');
      await onLogin?.(payload.user);
    } catch (error) {
      setErrorMsg(error?.message || '提交失败，请稍后重试。');
    } finally {
      setSubmitting(false);
    }
  };

  const toggleAuthMode = () => {
    setIsLogin((prev) => !prev);
    setLoginMethod('password');
    setErrorMsg('');
    setSuccessMsg('');
    setFormData((prev) => ({
      ...initialForm,
      agreed: prev.agreed
    }));
  };

  const isMobileLogin = isLogin && loginMethod === 'mobile';
  const isRegister = !isLogin;

  return (
    <div style={{ display: 'flex', width: '100vw', height: '100vh', backgroundColor: '#f4f7fe' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', position: 'relative', background: 'radial-gradient(circle at top left, #e0ecff 0%, #f4f7fe 100%)', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', top: 40, left: 40, display: 'flex', alignItems: 'center', gap: 12, color: 'var(--brand-primary)' }}>
          <CloudFog size={32} />
          <span style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-primary)' }}>统一登录平台</span>
        </div>

        <div style={{ zIndex: 1, textAlign: 'center' }}>
          <div style={{ width: 320, height: 320, background: 'linear-gradient(135deg,rgba(59,130,246,0.1) 0%, rgba(59,130,246,0.02) 100%)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: 'inset 0 0 40px rgba(255,255,255,0.5)', marginBottom: '40px' }}>
            <CloudFog size={160} color="var(--brand-primary)" style={{ opacity: 0.8 }} />
          </div>
          <h1 style={{ color: 'var(--text-primary)', fontSize: '2.5rem', fontWeight: 800, marginBottom: '16px' }}>吉云 GeoYun</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '1.125rem' }}>地球物理多模态数据智能处理中心</p>
        </div>
      </div>

      <div style={{ width: 500, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2 }}>
        <div className="card" style={{ width: 400, padding: '40px 32px', borderRadius: '16px', boxShadow: '0 20px 40px rgba(0,0,0,0.06)', border: '1px solid rgba(255,255,255,0.8)', background: '#ffffff', position: 'relative' }}>
          <button
            type="button"
            onClick={toggleAuthMode}
            title={`切换到${isLogin ? '注册' : '登录'}页面`}
            style={{ position: 'absolute', top: 0, right: 0, width: 0, height: 0, borderTop: '60px solid var(--brand-primary)', borderLeft: '60px solid transparent', borderTopRightRadius: '16px', cursor: 'pointer', padding: 0 }}
          >
            <span style={{ position: 'absolute', top: '-46px', right: 8, color: '#fff', fontSize: 12, fontWeight: 600 }}>
              {isLogin ? '注册' : '登录'}
            </span>
          </button>

          <h2 style={{ marginBottom: 24, fontSize: '1.5rem', fontWeight: 700 }}>
            {isLogin ? '欢迎登录吉云' : '手机号注册'}
          </h2>

          {isLogin && import.meta.env.DEV && (
            <div style={{ marginBottom: 18, padding: '12px 14px', borderRadius: 12, background: '#f8fafc', border: '1px solid #e2e8f0' }}>
              <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>演示账号，仅开发环境可见</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {users.slice(0, 5).map((user) => (
                  <button
                    key={user.id || user.account || user.name}
                    type="button"
                    onClick={() => {
                      setFormData((prev) => ({
                        ...prev,
                        identifier: user.account || user.name || '',
                        phone: user.phone || '',
                        password: '123456'
                      }));
                      setLoginMethod('password');
                    }}
                    style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: '8px 10px', textAlign: 'left', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: '#0f172a' }}
                  >
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{user.name}</span>
                    <span style={{ fontSize: 11, color: '#64748b' }}>
                      {user.account || user.phone || '--'}{user.status === 'disabled' ? ' · 已停用' : ''}
                    </span>
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 8 }}>默认测试密码：123456</div>
            </div>
          )}

          {isLogin && (
            <div style={{ display: 'flex', borderBottom: '1px solid var(--border-color)', marginBottom: 24 }}>
              <button type="button" onClick={() => { setLoginMethod('password'); setErrorMsg(''); setSuccessMsg(''); }} style={{ flex: 1, background: 'transparent', padding: '12px 0', fontSize: '1rem', color: loginMethod === 'password' ? 'var(--brand-primary)' : 'var(--text-secondary)', borderBottom: loginMethod === 'password' ? '2px solid var(--brand-primary)' : '2px solid transparent', borderRadius: 0, fontWeight: loginMethod === 'password' ? 600 : 400 }}>密码登录</button>
              <button type="button" onClick={() => { setLoginMethod('mobile'); setErrorMsg(''); setSuccessMsg(''); }} style={{ flex: 1, background: 'transparent', padding: '12px 0', fontSize: '1rem', color: loginMethod === 'mobile' ? 'var(--brand-primary)' : 'var(--text-secondary)', borderBottom: loginMethod === 'mobile' ? '2px solid var(--brand-primary)' : '2px solid transparent', borderRadius: 0, fontWeight: loginMethod === 'mobile' ? 600 : 400 }}>手机验证码</button>
            </div>
          )}

          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {(isRegister || !isMobileLogin) && (
              <div style={fieldRowStyle}>
                <User size={20} color="var(--text-secondary)" style={{ marginRight: 12 }} />
                <input type="text" name="identifier" value={formData.identifier} onChange={handleChange} placeholder={isRegister ? '设置登录账号' : '用户名 / 手机号 / 邮箱'} style={inputStyle} />
              </div>
            )}

            {isRegister && (
              <div style={fieldRowStyle}>
                <Building2 size={20} color="var(--text-secondary)" style={{ marginRight: 12 }} />
                <input type="text" name="company" value={formData.company} onChange={handleChange} placeholder="请输入公司名称" style={inputStyle} />
              </div>
            )}

            {(isRegister || isMobileLogin) && (
              <div style={fieldRowStyle}>
                <Phone size={20} color="var(--text-secondary)" style={{ marginRight: 12 }} />
                <input type="text" name="phone" value={formData.phone} onChange={handleChange} placeholder="请输入手机号" maxLength={11} style={inputStyle} />
              </div>
            )}

            {!isMobileLogin && (
              <div style={fieldRowStyle}>
                <Lock size={20} color="var(--text-secondary)" style={{ marginRight: 12 }} />
                <input type="password" name="password" value={formData.password} onChange={handleChange} placeholder={isRegister ? '设置密码（至少 6 位）' : '登录密码'} style={inputStyle} />
              </div>
            )}

            {(isRegister || isMobileLogin) && (
              <div style={{ ...fieldRowStyle, justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', flex: 1 }}>
                  <ShieldCheck size={20} color="var(--text-secondary)" style={{ marginRight: 12 }} />
                  <input type="text" name="code" value={formData.code} onChange={handleChange} placeholder="输入 6 位验证码" maxLength={6} style={inputStyle} />
                </div>
                <button type="button" onClick={handleSendCode} disabled={countdown > 0} style={{ background: 'transparent', color: countdown > 0 ? 'var(--text-secondary)' : 'var(--brand-primary)', fontSize: '0.875rem', cursor: countdown > 0 ? 'not-allowed' : 'pointer', fontWeight: 500 }}>
                  {countdown > 0 ? `${countdown}s 后重发` : '获取验证码'}
                </button>
              </div>
            )}

            {isRegister && (
              <div style={fieldRowStyle}>
                <Lock size={20} color="var(--text-secondary)" style={{ marginRight: 12 }} />
                <input type="password" name="confirmPassword" value={formData.confirmPassword} onChange={handleChange} placeholder="再次确认密码" style={inputStyle} />
              </div>
            )}

            {errorMsg && <div style={{ color: 'var(--danger)', fontSize: '0.875rem', marginTop: -8 }}>* {errorMsg}</div>}
            {successMsg && <div style={{ color: 'var(--success)', fontSize: '0.875rem', marginTop: -8 }}>* {successMsg}</div>}

            {isLogin && !isMobileLogin && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.875rem', marginTop: -4 }}>
                <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', color: 'var(--text-secondary)' }}>
                  <input type="checkbox" name="remember" checked={formData.remember} onChange={handleChange} style={{ marginRight: 8 }} />
                  记住登录状态
                </label>
                <span style={{ color: '#94a3b8' }}>短信登录可免密码</span>
              </div>
            )}

            <button type="submit" className="btn-primary" disabled={submitting} style={{ width: '100%', padding: 12, fontSize: '1.125rem', borderRadius: 8, marginTop: 12, background: isLogin ? 'var(--brand-primary)' : '#e67e22', opacity: submitting ? 0.7 : 1 }}>
              {submitting ? '提交中...' : (isLogin ? '立即登录' : '立即注册')}
            </button>
          </form>

          {isLogin && (
            <div style={{ marginTop: 32 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24 }}>
                <div style={{ flex: 1, height: 1, background: 'var(--border-color)' }} />
                <span className="text-xs text-muted">其他登录方式</span>
                <div style={{ flex: 1, height: 1, background: 'var(--border-color)' }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'center', gap: 20 }}>
                <button type="button" title="微信登录暂未开放" style={{ width: 40, height: 40, borderRadius: '50%', background: '#00c300', display: 'flex', justifyContent: 'center', alignItems: 'center', border: 'none', color: '#fff', cursor: 'not-allowed', opacity: 0.7 }}>
                  <MessageCircle size={20} />
                </button>
                <button type="button" title="邮箱登录暂未开放" style={{ width: 40, height: 40, borderRadius: '50%', background: '#ea4335', display: 'flex', justifyContent: 'center', alignItems: 'center', border: 'none', color: '#fff', cursor: 'not-allowed', opacity: 0.7 }}>
                  <Mail size={20} />
                </button>
              </div>
            </div>
          )}

          <div style={{ marginTop: 24, display: 'flex', justifyContent: 'center', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
            <label style={{ display: 'flex', alignItems: 'flex-start', cursor: 'pointer', textAlign: 'left', lineHeight: 1.4 }}>
              <input type="checkbox" name="agreed" checked={formData.agreed} onChange={handleChange} style={{ marginRight: 6, marginTop: 2 }} />
              <span>我已阅读并同意《吉云服务协议》和《隐私政策》</span>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Auth;
