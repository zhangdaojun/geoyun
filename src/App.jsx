import React, { lazy, Suspense, useMemo, useState, useEffect } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import Header from './components/Header';
import Dashboard from './components/Dashboard';
import Auth from './components/Auth';
import InviteReceiverModal from './components/InviteReceiverModal';
import { ensureAppSettings } from './utils/appSettings';
import { ensureUserList } from './utils/accessControl';
import { msg } from './utils/message';
import { loadPersistedAppState } from './app/appStorage';
import { useAppPersistence } from './app/useAppPersistence';
import { useGlobalSearch } from './app/useGlobalSearch';
import { useProjectSync } from './app/useProjectSync';
import { useSessionState } from './app/useSessionState';
import { useUserSync } from './app/useUserSync';
import './index.css';

const MapView = lazy(() => import('./components/MapView'));
const Projects = lazy(() => import('./components/Projects'));
const DataDrive = lazy(() => import('./components/DataDrive'));
const CloudCompute = lazy(() => import('./components/CloudCompute'));
const SystemSettings = lazy(() => import('./components/SystemSettings'));
const BackendUserAdmin = lazy(() => import('./components/BackendUserAdmin'));

const PageFallback = () => (
  <div className="dashboard-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-secondary)' }}>
    正在加载模块...
  </div>
);

function App() {
  const persistedState = useMemo(() => loadPersistedAppState(), []);
  const navigate = useNavigate();
  const location = useLocation();

  const currentView = location.pathname === '/' ? 'dashboard' : location.pathname.split('/')[1];

  const [selectedProject, setSelectedProject] = useState(() => {
    if (!persistedState?.selectedProjectId || !persistedState?.projectsList?.length) return null;
    return persistedState.projectsList.find(project => project.id === persistedState.selectedProjectId) || null;
  });
  const [pendingDriveFolderId, setPendingDriveFolderId] = useState(persistedState?.pendingDriveFolderId || null);
  const [pendingDrivePointRequest, setPendingDrivePointRequest] = useState(null);
  const [pendingProjectSelection, setPendingProjectSelection] = useState(null);
  const [openProjectCreateModal, setOpenProjectCreateModal] = useState(false);
  const [globalSearchTerm, setGlobalSearchTerm] = useState('');
  const [appSettings, setAppSettings] = useState(() => ensureAppSettings(persistedState?.appSettings));

  const { users, setUsers } = useUserSync(persistedState);
  const {
    isAuthenticated,
    isInitializing,
    currentUser,
    handleLogin,
    handleLogout
  } = useSessionState({
    persistedState,
    users,
    setUsers,
    currentView,
    navigate,
    setSelectedProject,
    setPendingDriveFolderId,
    setGlobalSearchTerm
  });

  const {
    projectsList,
    effectiveSelectedProject,
    projectSyncStatus,
    handleProjectCreate,
    handleProjectUpdate,
    handleDeleteProjectApi,
    handleReloadProject
  } = useProjectSync({
    persistedState,
    currentUser,
    selectedProject,
    setSelectedProject,
    navigate,
    setPendingDriveFolderId,
    setPendingProjectSelection
  });

  useEffect(() => {
    const match = location.pathname.match(/^\/projects\/([^\/]+)/);
    if (match) {
      const urlProjectId = match[1];
      if (!selectedProject || selectedProject.id !== urlProjectId) {
        const found = projectsList.find(p => p.id === urlProjectId);
        if (found) {
          setSelectedProject(found);
        }
      }
    }
  }, [location.pathname, projectsList, selectedProject]);
  const search = useGlobalSearch({
    appSettings,
    projectsList,
    globalSearchTerm,
    setGlobalSearchTerm,
    setSelectedProject,
    setPendingDriveFolderId,
    navigate
  });

  useAppPersistence({
    appSettings,
    currentUser,
    currentView,
    isAuthenticated,
    pendingDriveFolderId,
    projectsList,
    selectedProject,
    users
  });

  if (isInitializing) {
    return <PageFallback />;
  }

  if (!isAuthenticated) {
    return <Auth users={users} onLogin={handleLogin} />;
  }

  return (
    <div className="app-container">
      <Sidebar
        currentView={currentView}
        navigate={navigate}
        projects={projectsList}
        selectedProject={effectiveSelectedProject}
        currentUser={currentUser}
        currentDriveFolderId={pendingDriveFolderId}
        setPendingDriveFolderId={setPendingDriveFolderId}
        setPendingProjectSelection={setPendingProjectSelection}
        setPendingDrivePointRequest={setPendingDrivePointRequest}
        setSelectedProject={(project) => {
          setSelectedProject(project);
          if (project) setPendingDriveFolderId(null);
        }}
        onReloadProject={handleReloadProject}
        onDeleteProject={handleDeleteProjectApi}
        onCreateProject={() => {
          setSelectedProject(null);
          setPendingDriveFolderId(null);
          navigate('/projects');
          setOpenProjectCreateModal(true);
        }}
      />
      <div className="main-content">
        <InviteReceiverModal
          currentUser={currentUser}
          projectsList={projectsList}
          onUpdateProject={handleProjectUpdate}
        />
        <Header
          currentUser={currentUser}
          searchQuery={search.globalSearchTerm}
          searchResults={search.globalSearchResults}
          onSearchChange={search.setGlobalSearchTerm}
          onSearchSelect={search.handleSearchSelect}
          onLogout={handleLogout}
        />
        <Suspense fallback={<PageFallback />}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/map" element={
              <MapView
                projects={projectsList}
                onEnterProjectDetail={(project) => {
                  setSelectedProject(project);
                  setPendingDriveFolderId(null);
                  navigate(`/projects/${project.id}`);
                }}
              />
            } />
            <Route path="/projects/*" element={
              <Projects
                appSettings={appSettings}
                currentUser={currentUser}
                users={users}
                projects={projectsList}
                selectedProject={effectiveSelectedProject}
                setSelectedProject={(project) => {
                  setSelectedProject(project);
                  if (!project) setPendingDriveFolderId(null);
                }}
                onCreateProject={handleProjectCreate}
                onUpdateProject={handleProjectUpdate}
                onDeleteProject={handleDeleteProjectApi}
                pendingSelection={pendingProjectSelection}
                clearPendingSelection={() => setPendingProjectSelection(null)}
                openNewModalRequest={openProjectCreateModal}
                clearOpenNewModalRequest={() => setOpenProjectCreateModal(false)}
                onOpenDataDrive={(project, folderId) => {
                  setSelectedProject(project);
                  setPendingDriveFolderId(folderId || null);
                  setPendingDrivePointRequest(null);
                  setPendingProjectSelection(null);
                  navigate(`/projects/${project.id}/data`);
                }}
              />
            } />
            <Route path="/projects/:id/data" element={
              <DataDrive
                appSettings={appSettings}
                currentUser={currentUser}
                projects={projectsList}
                projectSyncStatus={projectSyncStatus}
                selectedProject={effectiveSelectedProject}
                onGoToProjects={() => navigate(`/projects/${effectiveSelectedProject?.id || ''}`)}
                onUpdateProject={handleProjectUpdate}
                initialFolderId={pendingDriveFolderId}
                pendingPointRequest={pendingDrivePointRequest}
              />
            } />
            <Route path="/data" element={<Navigate to="/projects" replace />} />
            <Route path="/cloud" element={<CloudCompute currentUser={currentUser} />} />
            <Route path="/settings" element={
              <SystemSettings
                settings={appSettings}
                currentUser={currentUser}
                onSave={({ settings: nextSettings, users: nextUsers = users, silent = false, preserveUsers = false }) => {
                  const normalizedNextUsers = preserveUsers ? users : ensureUserList(nextUsers);
                  if (!preserveUsers) {
                    setUsers(normalizedNextUsers);
                  }
                  setAppSettings(ensureAppSettings(nextSettings));
                  if (!silent) {
                    msg.success('系统设置与用户信息已保存。');
                  }
                }}
              />
            } />
            <Route path="/admin-users" element={<BackendUserAdmin currentUser={currentUser} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </div>
    </div>
  );
}

export default App;
