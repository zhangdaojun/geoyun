import React, { useState } from 'react';
import { MapContainer, TileLayer, Polygon, Marker, Popup } from 'react-leaflet';
import { Layers, Map as MapIcon, Maximize, Crosshair } from 'lucide-react';

// Remove the invalid useMap child component

const MapView = ({ projects, onEnterProjectDetail }) => {
  // Center roughly to see all of China
  const defaultPosition = [35.86166, 104.195397];
  const defaultZoom = 4;
  
  const [, setActiveProject] = useState(null);
  const [showOverlayMenu, setShowOverlayMenu] = useState(false);
  const [activeOverlays, setActiveOverlays] = useState({
    railway: false,
    topo: false
  });
  const [mapRef, setMapRef] = useState(null);

  // Status mapping for visual styling
  const getStatusColor = (status) => {
    switch(status) {
      case '采集中': return '#4f46e5';
      case '解算完成': return '#10b981';
      case '云端处理中': return '#f59e0b';
      default: return '#64748b';
    }
  };

  return (
    <div className="map-view-container">
      {/* Floating control overlay on top of the map */}
      <div className="map-overlay glass card">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid var(--border-color)', paddingBottom: '12px', marginBottom: '12px' }}>
          <MapIcon size={18} className="text-muted" />
          <h3 className="text-sm" style={{ margin: 0 }}>全国测区资产分布状态</h3>
        </div>
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="text-xs font-medium">当前探测项目总量：</span>
            <span className="text-xs text-muted" style={{ background: 'var(--brand-light)', color: 'var(--brand-primary)', padding: '2px 8px', borderRadius: '4px', fontWeight: 600 }}>
              {projects.length} 个
            </span>
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.75rem' }}><span style={{width: 8, height: 8, borderRadius: '50%', background: '#4f46e5'}}></span> 采集中</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.75rem' }}><span style={{width: 8, height: 8, borderRadius: '50%', background: '#f59e0b'}}></span> 云处理</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.75rem' }}><span style={{width: 8, height: 8, borderRadius: '50%', background: '#10b981'}}></span> 完结</div>
          </div>

          <div style={{ position: 'relative' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              <button 
                onClick={() => setShowOverlayMenu(!showOverlayMenu)}
                style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', background: showOverlayMenu ? 'var(--brand-primary)' : 'var(--surface-hover)', border: showOverlayMenu ? 'none' : '1px solid var(--border-color)', color: showOverlayMenu ? '#fff' : 'var(--text-primary)', padding: '8px', borderRadius: '6px', fontSize: '0.875rem', cursor: 'pointer' }}
              >
                <Layers size={14} /> 叠加辅助图层
              </button>
              <button 
                onClick={() => mapRef && mapRef.flyTo(defaultPosition, defaultZoom)}
                style={{ width: '100%', background: 'var(--surface-hover)', border: '1px solid var(--border-color)', padding: '8px', borderRadius: '6px', fontSize: '0.875rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', cursor: 'pointer', color: 'var(--text-primary)' }}
              >
                <Crosshair size={14} className="text-muted"/> 全局居中
              </button>
            </div>

            {/* Dropdown for toggling layers */}
            {showOverlayMenu && (
              <div className="card glass" style={{ position: 'absolute', top: '100%', left: 0, width: '100%', marginTop: '8px', padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px', zIndex: 10 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.75rem', cursor: 'pointer' }}>
                  <input type="checkbox" checked={activeOverlays.railway} onChange={() => setActiveOverlays({...activeOverlays, railway: !activeOverlays.railway})} />
                  路网基建与交通覆盖层
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.75rem', cursor: 'pointer' }}>
                  <input type="checkbox" checked={activeOverlays.topo} onChange={() => setActiveOverlays({...activeOverlays, topo: !activeOverlays.topo})} />
                  等高线地形晕渲叠加层
                </label>
              </div>
            )}
          </div>
        </div>
      </div>

      <MapContainer ref={setMapRef} center={defaultPosition} zoom={defaultZoom} className="leaflet-container" zoomControl={false}>
        <TileLayer
          attribution='&copy; Esri &mdash; Source: Esri, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP'
          url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
          maxZoom={18}
        />
        
        {/* Active Overlays */}
        {activeOverlays.railway && (
          <TileLayer
            url="https://{s}.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png"
            opacity={0.8}
            zIndex={10}
          />
        )}
        {activeOverlays.topo && (
           <TileLayer
            url="https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png"
            opacity={0.5}
            zIndex={5}
          />
        )}

        {/* Dynamic Project Markers and Polygons */}
        {projects.map(project => (
          <React.Fragment key={project.id}>
            {/* Draw Polygon if available */}
            {project.areaCoords && (
              <Polygon 
                pathOptions={{ 
                  color: getStatusColor(project.status), 
                  fillColor: getStatusColor(project.status), 
                  fillOpacity: 0.2 
                }} 
                positions={project.areaCoords} 
              />
            )}
            
            {/* Draw Marker */}
            <Marker 
              position={project.coords}
              eventHandlers={{
                click: () => setActiveProject(project)
              }}
            >
              <Popup>
                <div style={{ padding: '4px', minWidth: '180px' }}>
                  <h4 style={{ margin: '0 0 8px 0', fontSize: '14px', color: 'var(--text-primary)' }}>{project.name}</h4>
                  
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#666' }}>
                      <span>地区：</span><span style={{ fontWeight: 500 }}>{project.location}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#666' }}>
                      <span>方法：</span><span style={{ fontWeight: 500 }}>{project.method}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#666' }}>
                       <span>状态：</span>
                       <span style={{ color: getStatusColor(project.status), fontWeight: 600 }}>{project.status}</span>
                    </div>
                  </div>

                  <button
                    className="btn-primary"
                    style={{ width: '100%', padding: '6px', fontSize: '12px' }}
                    onClick={() => onEnterProjectDetail?.(project)}
                  >
                    进入测区详情
                  </button>
                </div>
              </Popup>
            </Marker>
          </React.Fragment>
        ))}

      </MapContainer>
    </div>
  );
};

export default MapView;
