import React, { lazy, Suspense } from 'react';

const ERTParser = lazy(() => import('../../../components/ERTParser'));
const MTParser = lazy(() => import('../../../components/MTParser'));
const XParser = lazy(() => import('../../../components/XParser'));
const YParser = lazy(() => import('../../../components/YParser'));
const EH4ProjectViewer = lazy(() => import('../../../components/EH4ProjectViewer'));
const F3IndexViewer = lazy(() => import('../../../components/F3IndexViewer'));
const DesignCoordViewer = lazy(() => import('../../../components/DesignCoordViewer'));

const ParserFallback = () => (
  <div style={{ position: 'fixed', inset: 0, zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(15,23,42,0.28)', color: '#fff', fontWeight: 700 }}>
    正在加载解析器...
  </div>
);

const withContent = (item) => (
  item?.rawFile ? Object.assign(item.rawFile, { content: item.content }) : item
);

const resolveParserTarget = (fileItem) => {
  const name = (fileItem?.name || '').toLowerCase();
  if (name.endsWith('.psd')) return 'x';
  if (/\.(fh|fm|fl|mtts)$/i.test(name)) return 'y';
  return 'mt';
};

export const DriveParserLauncher = ({
  fileSystem,
  setFileSystem,
  selectedProject,
  currentUser,
  parsingFile,
  parsingMTFile,
  parsingXFile,
  parsingYFile,
  parsingEH4Project,
  parsingF3IndexProject,
  parsingDesignCoordFile,
  setParsingFile,
  setParsingMTFile,
  setParsingXFile,
  setParsingYFile,
  setParsingEH4Project,
  setParsingF3IndexProject,
  setParsingDesignCoordFile,
  handleSwitchType,
  handleSwitchF3Band,
  handleSwitchFile,
  logFileOperations,
  buildFileOperationPayload
}) => {
  const openDataFile = (fileItem) => {
    if (fileItem?.type === 'mtts-group') {
      setParsingYFile(fileItem);
      return;
    }
    const target = resolveParserTarget(fileItem);
    if (target === 'x') setParsingXFile(fileItem);
    else if (target === 'y') setParsingYFile(fileItem);
    else setParsingMTFile(fileItem);
  };

  return (
    <Suspense fallback={<ParserFallback />}>
      {parsingFile && (
        <ERTParser
          fileObj={withContent(parsingFile)}
          fileSystem={fileSystem}
          selectedProject={selectedProject}
          onUpdateFileSystem={setFileSystem}
          logFileOperations={logFileOperations}
          buildFileOperationPayload={buildFileOperationPayload}
          onClose={() => setParsingFile(null)}
        />
      )}

      {parsingDesignCoordFile && (
        <DesignCoordViewer
          fileObj={parsingDesignCoordFile}
          fileSystem={fileSystem}
          onUpdateFileSystem={setFileSystem}
          onOpenDataFile={openDataFile}
          onOpenF3Overview={(fileItem) => {
            setParsingDesignCoordFile(null);
            setParsingF3IndexProject(fileItem);
          }}
          onOpenEH4Overview={(fileItem) => {
            setParsingDesignCoordFile(null);
            setParsingEH4Project(fileItem);
          }}
          onClose={() => setParsingDesignCoordFile(null)}
        />
      )}

      {parsingMTFile && (
        <MTParser
          fileObj={withContent(parsingMTFile)}
          fileSystem={fileSystem}
          onClose={() => setParsingMTFile(null)}
          onSwitchType={(type) => handleSwitchType(parsingMTFile.rawFile || parsingMTFile, type)}
          onPrev={() => handleSwitchFile(-1, parsingMTFile.rawFile || parsingMTFile, 'Z')}
          onNext={() => handleSwitchFile(1, parsingMTFile.rawFile || parsingMTFile, 'Z')}
        />
      )}

      {parsingXFile && (
        <XParser
          fileObj={withContent(parsingXFile)}
          fileSystem={fileSystem}
          onClose={() => setParsingXFile(null)}
          onSwitchType={(type) => handleSwitchType(parsingXFile.rawFile || parsingXFile, type)}
          onPrev={() => handleSwitchFile(-1, parsingXFile.rawFile || parsingXFile, 'X')}
          onNext={() => handleSwitchFile(1, parsingXFile.rawFile || parsingXFile, 'X')}
        />
      )}

      {parsingYFile && (
        <YParser
          fileObj={withContent(parsingYFile)}
          fileSystem={fileSystem}
          currentUser={currentUser}
          onClose={() => setParsingYFile(null)}
          onSwitchType={(type) => handleSwitchType(parsingYFile.rawFile || parsingYFile, type)}
          onSwitchBand={(band) => handleSwitchF3Band(parsingYFile.rawFile || parsingYFile, band)}
          onPrev={() => handleSwitchFile(-1, parsingYFile.rawFile || parsingYFile, 'Y')}
          onNext={() => handleSwitchFile(1, parsingYFile.rawFile || parsingYFile, 'Y')}
        />
      )}

      {parsingEH4Project && (
        <EH4ProjectViewer
          fileObj={parsingEH4Project}
          fileSystem={fileSystem}
          selectedProject={selectedProject}
          onUpdateFileSystem={setFileSystem}
          onClose={() => setParsingEH4Project(null)}
        />
      )}

      {parsingF3IndexProject && (
        <F3IndexViewer
          fileObj={parsingF3IndexProject}
          fileSystem={fileSystem}
          onUpdateFileSystem={setFileSystem}
          isBackground={Boolean(parsingMTFile || parsingXFile || parsingYFile)}
          onClose={() => setParsingF3IndexProject(null)}
          onOpenFile={openDataFile}
        />
      )}
    </Suspense>
  );
};

export default DriveParserLauncher;
