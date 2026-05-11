import { useReducer, useMemo, useEffect } from 'react';

const initialState = {
  viewMode: 'grid',
  selectionMode: false,
  selectedDriveItemIds: new Set()
};

function driveSelectionReducer(state, action) {
  switch (action.type) {
    case 'SET_VIEW_MODE':
      return { ...state, viewMode: action.payload };
    
    case 'TOGGLE_SELECTION_MODE':
      const isEnabled = action.payload ?? !state.selectionMode;
      return {
        ...state,
        selectionMode: isEnabled,
        selectedDriveItemIds: isEnabled ? state.selectedDriveItemIds : new Set()
      };
    
    case 'TOGGLE_ITEM_SELECTION': {
      const { id } = action.payload;
      if (!id) return state;
      const nextSet = new Set(state.selectedDriveItemIds);
      if (nextSet.has(id)) {
        nextSet.delete(id);
      } else {
        nextSet.add(id);
      }
      return {
        ...state,
        selectionMode: true,
        selectedDriveItemIds: nextSet
      };
    }
    
    case 'TOGGLE_SELECT_ALL': {
      const { visibleIds } = action.payload;
      if (!visibleIds?.length) return state;
      
      const allSelected = visibleIds.every(id => state.selectedDriveItemIds.has(id));
      const nextSet = new Set(state.selectedDriveItemIds);
      
      if (allSelected) {
        visibleIds.forEach(id => nextSet.delete(id));
      } else {
        visibleIds.forEach(id => nextSet.add(id));
      }
      
      return {
        ...state,
        selectionMode: true,
        selectedDriveItemIds: nextSet
      };
    }
    
    case 'CLEAR_SELECTION':
      return {
        ...state,
        selectionMode: false,
        selectedDriveItemIds: new Set()
      };

    case 'CLEANUP_INVALID_SELECTIONS': {
      const { validIds } = action.payload;
      if (!state.selectedDriveItemIds.size) return state;
      const validSet = new Set(validIds);
      const nextSet = new Set([...state.selectedDriveItemIds].filter(id => validSet.has(id)));
      if (nextSet.size === state.selectedDriveItemIds.size) return state;
      return {
        ...state,
        selectedDriveItemIds: nextSet,
        selectionMode: nextSet.size > 0 ? state.selectionMode : false
      };
    }
      
    default:
      return state;
  }
}

export function useDriveSelection(displayItems = []) {
  const [state, dispatch] = useReducer(driveSelectionReducer, initialState);

  useEffect(() => {
    const validIds = displayItems.map((item) => item.id).filter(Boolean);
    dispatch({ type: 'CLEANUP_INVALID_SELECTIONS', payload: { validIds } });
  }, [displayItems]);

  const actions = useMemo(() => ({
    setViewMode: (mode) => dispatch({ type: 'SET_VIEW_MODE', payload: mode }),
    
    setSelectionMode: (enabled) => dispatch({ type: 'TOGGLE_SELECTION_MODE', payload: enabled }),
    
    toggleDriveItemSelection: (event, item) => {
      event?.stopPropagation?.();
      if (item?.id) {
        dispatch({ type: 'TOGGLE_ITEM_SELECTION', payload: { id: item.id } });
      }
    },
    
    toggleSelectAllVisibleDriveItems: () => {
      const visibleIds = displayItems.map((item) => item.id).filter(Boolean);
      dispatch({ type: 'TOGGLE_SELECT_ALL', payload: { visibleIds } });
    },
    
    clearDriveSelection: () => dispatch({ type: 'CLEAR_SELECTION' })
    
  }), [displayItems]);

  return {
    viewMode: state.viewMode,
    selectionMode: state.selectionMode,
    selectedDriveItemIds: state.selectedDriveItemIds,
    ...actions
  };
}
