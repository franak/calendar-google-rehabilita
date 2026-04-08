(() => {
  const VIEW_CALENDAR = "month"; // Mes por defecto
  const VIEW_LIST = "list";
  const VIEW_MONTH = "month";
  const VIEW_TIMELINE = "timeline";
  const VIEW_GANTT = "gantt";
  const VIEW_INFOGRAPHIC = "infographic";
  const VIEW_SUBSCRIPTIONS = "subscriptions";
  const VIEW_ACCOUNTS = "accounts";
  const VIEW_ACCOUNT_EDIT = "account_edit";
  const VIEW_AUDIT = "audit";
  const VIEW_ENVIRONMENTS = "environments";
  const VIEW_ENVIRONMENT_EDIT = "environment_edit";
  const VIEW_DOCUMENTS = 'documents';
  const VIEW_DOCUMENT_EDIT = 'document_edit';
  const VIEW_SUBSCRIPTION_EDIT = "subscription_edit";

  // Exponer a global para onclick handlers
  window.VIEW_ACCOUNT_EDIT = VIEW_ACCOUNT_EDIT;
  window.VIEW_ACCOUNTS = VIEW_ACCOUNTS;
  window.VIEW_INFOGRAPHIC = VIEW_INFOGRAPHIC;
  window.VIEW_SUBSCRIPTIONS = VIEW_SUBSCRIPTIONS;
  window.VIEW_AUDIT = VIEW_AUDIT;
  window.VIEW_ENVIRONMENTS = VIEW_ENVIRONMENTS;
  window.VIEW_ENVIRONMENT_EDIT = VIEW_ENVIRONMENT_EDIT;
  window.VIEW_DOCUMENTS = VIEW_DOCUMENTS;
  window.VIEW_DOCUMENT_EDIT = VIEW_DOCUMENT_EDIT;
  window.VIEW_SUBSCRIPTION_EDIT = VIEW_SUBSCRIPTION_EDIT;

  const DEFAULT_MONTH_RANGE = 3; // meses hacia delante

  const viewContainer = document.getElementById("viewContainer");
  const statusMessageEl = document.getElementById("statusMessage");
  const loaderEl = document.getElementById("loader");
  const searchInput = document.getElementById("searchInput");
  const forceSyncBtn = document.getElementById("forceSyncBtn");
  const viewButtons = Array.from(
    document.querySelectorAll(".view-button")
  );

  let events = [];
  let filteredEvents = [];
  let currentView = VIEW_LIST;
  let currentEditRecordId = null;
  let currentMonthDate = new Date();
  let activeSources = new Set(); // IDs de fuentes activas
  let navigationHistory = [];
  let currentUser = null;

  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast-msg ${type}`;
    const icon = type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-circle' : 'info-circle';
    toast.innerHTML = `<i class="bi bi-${icon}"></i><span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  /**
   * EnterpriseTable v2: Componente modular de tabla con persistencia, 
   * drag & drop de columnas, redimensionado y selección avanzada.
   */
  class EnterpriseTable {
    constructor(options = {}) {
      this.id = options.id || 'ent-table';
      this.columns = options.columns || []; // [{id, label, width, visible, type, align, sortable}]
      this.data = options.data || [];
      this.originalData = [...this.data];
      this.onRowClick = options.onRowClick || null;
      this.onRowDblClick = options.onRowDblClick || null;
      this.onBulkDelete = options.onBulkDelete || null;
      this.onCreateNew = options.onCreateNew || null;
      
      // Estado interno
      this.selection = new Set();
      this.lastSelectedIndex = -1;
      this.sortCol = options.defaultSort || (this.columns[0] ? this.columns[0].id : null);
      this.sortDir = options.defaultDir || 'asc';
      this.pageSize = 25;
      this.currentPage = 1;
      this.searchQuery = '';
      
      // Drag & Resize state
      this.draggingColumn = null;
      this.resizingColumn = null;
      this.startX = 0;
      this.startWidth = 0;

      this.internalColumns = [...options.columns]; // copia de los defaults para resetear

      // NO cargamos prefs aquí - loadPrefs se debe llamar con await antes de render
    }

    // Factory async: úsala en lugar de `new` para garantizar que prefs estén cargadas antes de render
    static async create(options = {}) {
      const t = new EnterpriseTable(options);
      await t.loadPrefs();
      return t;
    }

    async loadPrefs() {
      if (!currentUser || !currentUser.id) return;
      try {
        let raw = currentUser.interface_Prefs;

        // Para root, priorizar localStorage si existe (más reciente)
        if (currentUser.role === 'root') {
          const lsAll = localStorage.getItem('et_prefs_root_all');
          if (lsAll) {
            const lsPrefs = JSON.parse(lsAll);
            if (lsPrefs[this.id]) {
              // Usar localStorage si está más actualizado que la DB
              raw = lsAll;
            }
          }
        }

        const prefs = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
        const tablePrefs = prefs[this.id];
        if (tablePrefs && tablePrefs.columns && tablePrefs.columns.length > 0) {
          const newCols = [];
          tablePrefs.columns.forEach(pCol => {
            const baseCol = this.internalColumns.find(c => c.id === pCol.id);
            if (baseCol) newCols.push({ ...baseCol, ...pCol });
          });
          this.internalColumns.forEach(c => {
            if (!newCols.find(nc => nc.id === c.id)) newCols.push(c);
          });
          this.columns = newCols;
          if (tablePrefs.pageSize) this.pageSize = tablePrefs.pageSize;
          if (tablePrefs.sortCol) this.sortCol = tablePrefs.sortCol;
          if (tablePrefs.sortDir) this.sortDir = tablePrefs.sortDir;
        }
      } catch (e) { console.error('Error loading prefs', e); }
    }

    // Clave de localStorage para root
    _localKey() {
      return `et_prefs_root_${this.id}`;
    }

    // Construye un objeto con el estado actual de la tabla para guardarlo
    _buildPrefsPayload() {
      return {
        columns: this.columns.map(c => ({ id: c.id, width: c.width, visible: c.visible !== false })),
        pageSize: this.pageSize,
        sortCol: this.sortCol,
        sortDir: this.sortDir
      };
    }

    async savePrefs(silent = false) {
      if (!currentUser || !currentUser.id) {
        console.warn('[EnterpriseTable] savePrefs skipped: no currentUser');
        return;
      }
      try {
        const raw = currentUser.interface_Prefs;
        const currentAllPrefs = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
        currentAllPrefs[this.id] = this._buildPrefsPayload();
        const prefsStr = JSON.stringify(currentAllPrefs);
        currentUser.interface_Prefs = prefsStr;

        // Para root: guardar tb en localStorage como copia local rápida
        if (currentUser.role === 'root') {
          try { localStorage.setItem('et_prefs_root_all', prefsStr); } catch (_) {}
        }

        console.log('[EnterpriseTable] Guardando prefs para', this.id, currentAllPrefs[this.id]);
        const res = await fetch(`/apiserv/admin/accounts/${currentUser.id}/prefs`, {
          method: 'PUT',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ interface_Prefs: prefsStr })
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(`HTTP ${res.status}: ${errData.error || 'Unknown error'}`);
        }
        if (!silent) showToast('Preferencias guardadas', 'success');
        console.log('[EnterpriseTable] Prefs guardadas correctamente');
      } catch (e) { 
        console.error('[EnterpriseTable] Error saving prefs', e);
        if (!silent) showToast('Error al guardar preferencias: ' + e.message, 'error');
      }
    }

    async initDefaultPrefs() {
      if (!currentUser || !currentUser.id) return;
      try {
        const raw = currentUser.interface_Prefs;
        const currentAllPrefs = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
        currentAllPrefs[this.id] = this._buildPrefsPayload();
        const prefsStr = JSON.stringify(currentAllPrefs);
        currentUser.interface_Prefs = prefsStr;
        console.log('[EnterpriseTable] Inicializando prefs por defecto para', this.id);
        const res = await fetch(`/apiserv/admin/accounts/${currentUser.id}/prefs`, {
          method: 'PUT',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ interface_Prefs: prefsStr })
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(`HTTP ${res.status}: ${errData.error || 'Unknown error'}`);
        }
        console.log('[EnterpriseTable] Prefs por defecto inicializadas para', this.id);
      } catch (e) { console.error('[EnterpriseTable] Error on initDefaultPrefs', e); }
    }

    async resetPrefs() {
      if (!currentUser || !currentUser.id) return;
      if (!confirm('¿Seguro que quieres restablecer el diseño de esta tabla a los valores por defecto?')) return;
      try {
        this.columns = [...this.internalColumns];
        this.pageSize = 25;
        const raw = currentUser.interface_Prefs;
        const currentAllPrefs = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
        currentAllPrefs[this.id] = this._buildPrefsPayload();
        const prefsStr = JSON.stringify(currentAllPrefs);
        currentUser.interface_Prefs = prefsStr;

        // Para root: actualizar también localStorage
        if (currentUser.role === 'root') {
          try { localStorage.setItem('et_prefs_root_all', prefsStr); } catch (_) {}
        }

        const res = await fetch(`/apiserv/admin/accounts/${currentUser.id}/prefs`, {
          method: 'PUT',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ interface_Prefs: prefsStr })
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        showToast('Diseño restablecido a los valores por defecto', 'info');
        this.render();
      } catch (e) { 
        console.error('[EnterpriseTable] Error resetting prefs', e);
        showToast('Error al restablecer: ' + e.message, 'error');
      }
    }

    setData(newData) {
      this.originalData = [...newData];
      this.applyFiltersAndSort();
    }

    applyFiltersAndSort() {
      let filtered = [...this.originalData];
      
      // Search
      if (this.searchQuery) {
        const q = this.searchQuery.toLowerCase();
        filtered = filtered.filter(row => {
          return Object.values(row).some(val => String(val).toLowerCase().includes(q));
        });
      }

      // Sort
      if (this.sortCol) {
        filtered.sort((a, b) => {
          let valA = a[this.sortCol];
          let valB = b[this.sortCol];
          if (valA === null || valA === undefined) valA = '';
          if (valB === null || valB === undefined) valB = '';
          
          if (typeof valA === 'string') {
            return this.sortDir === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
          }
          return this.sortDir === 'asc' ? valA - valB : valB - valA;
        });
      }

      this.data = filtered;
      this.render();
    }

    render(container = null) {
      if (container) this.container = container;
      if (!this.container) return;

      this.container.innerHTML = `
        <div class="enterprise-container">
          <div class="enterprise-toolbar" id="${this.id}-toolbar"></div>
          <div class="enterprise-table-wrapper" id="${this.id}-wrapper">
            <table class="ent-table" id="${this.id}-table">
              <thead><tr id="${this.id}-header"></tr></thead>
              <tbody id="${this.id}-body"></tbody>
            </table>
          </div>
          <div class="enterprise-footer" id="${this.id}-footer"></div>
        </div>
      `;

      this.renderToolbar();
      this.renderHeader();
      this.renderRows();
      this.renderFooter();
      this.attachResizeEvents();
    }

    renderToolbar() {
      const toolbar = document.getElementById(`${this.id}-toolbar`);
      toolbar.innerHTML = `
        <div class="toolbar-actions">
          <button class="btn btn-primary btn-sm rounded-pill px-3" id="${this.id}-btn-new">
            <i class="bi bi-plus-lg me-2"></i>Nuevo
          </button>
          <button class="btn btn-outline-primary btn-sm rounded-pill px-3" id="${this.id}-btn-edit" disabled>
            <i class="bi bi-pencil-square me-2"></i>Editar
          </button>
          <button class="btn btn-outline-danger btn-sm rounded-pill px-3" id="${this.id}-btn-delete" disabled>
            <i class="bi bi-trash3 me-2"></i>Borrar
          </button>
          <div class="selection-info" id="${this.id}-selection-info">
            <span id="${this.id}-count">0 seleccionados</span>
            <button class="btn-deselect" id="${this.id}-btn-clear">Descartar</button>
          </div>
        </div>
        <div class="d-flex align-items-center gap-3">
          <div class="input-group input-group-sm" style="width: 240px;">
            <span class="input-group-text bg-transparent border-end-0"><i class="bi bi-search text-muted"></i></span>
            <input type="search" class="form-control border-start-0" placeholder="Buscar..." id="${this.id}-search" value="${this.searchQuery}">
          </div>
          <button class="btn btn-outline-secondary btn-sm" title="Ajustes de tabla" id="${this.id}-btn-settings">
            <i class="bi bi-gear-fill"></i>
          </button>
        </div>
      `;

      document.getElementById(`${this.id}-search`).addEventListener('input', (e) => {
        this.searchQuery = e.target.value;
        this.currentPage = 1;
        this.applyFiltersAndSort();
      });

      document.getElementById(`${this.id}-btn-new`).onclick = () => this.onCreateNew && this.onCreateNew();
      document.getElementById(`${this.id}-btn-edit`).onclick = () => {
        if (this.selection.size === 1 && this.onRowDblClick) {
          const id = Array.from(this.selection)[0];
          const row = this.data.find(r => r.id === id);
          if (row) this.onRowDblClick(row);
        }
      };
      document.getElementById(`${this.id}-btn-delete`).onclick = () => this.onBulkDelete && this.onBulkDelete(Array.from(this.selection));
      document.getElementById(`${this.id}-btn-clear`).onclick = () => this.clearSelection();
      document.getElementById(`${this.id}-btn-settings`).onclick = () => this.resetPrefs();
    }

    renderHeader() {
      const header = document.getElementById(`${this.id}-header`);
      header.innerHTML = `
        <th style="width: 40px; text-align: center;">
          <input type="checkbox" id="${this.id}-select-all">
        </th>
        ${this.columns.filter(c => c.visible !== false).map(col => `
          <th class="th-draggable" data-col="${col.id}" draggable="true" style="width: ${col.width || 'auto'}; text-align: ${col.align || 'left'};">
            <div class="th-content">
              <span>${col.label}</span>
              ${this.sortCol === col.id ? `<i class="bi bi-sort-${this.sortDir === 'asc' ? 'down' : 'up'} sort-icon sort-active"></i>` : ''}
            </div>
            <div class="resize-handle" data-col="${col.id}" onmouseenter="this.parentElement.draggable=false" onmouseleave="this.parentElement.draggable=true"></div>
          </th>
        `).join('')}
      `;

      // Select All
      const selectAll = document.getElementById(`${this.id}-select-all`);
      selectAll.onchange = (e) => {
        const pageData = this.getPageData();
        if (e.target.checked) {
          pageData.forEach(row => this.selection.add(row.id));
        } else {
          pageData.forEach(row => this.selection.delete(row.id));
        }
        this.updateSelectionUI();
      };

      // Sort Click & Drag
      header.querySelectorAll('th[data-col]').forEach(th => {
        th.onclick = (e) => {
          if (e.target.classList.contains('resize-handle')) return;
          const colId = th.dataset.col;
          if (this.sortCol === colId) {
            this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
          } else {
            this.sortCol = colId;
            this.sortDir = 'asc';
          }
          this.savePrefs();
          this.applyFiltersAndSort();
        };

        // Sorting and Drag events
        // Ya no activamos draggable=true aquí dinámicamente sino que lo dejamos en el HTML
        // y lo desactivamos al entrar en el resize-handle.
        th.ondragstart = (e) => {
          this.draggingColumn = th.dataset.col;
          e.dataTransfer.setData('text/plain', th.dataset.col);
          th.style.opacity = '0.5';
        };
        th.ondragend = () => {
          th.style.opacity = '1';
          header.querySelectorAll('th').forEach(t => t.classList.remove('drop-target-left', 'drop-target-right'));
        };
        th.ondragover = (e) => {
          e.preventDefault();
          const rect = th.getBoundingClientRect();
          const mid = rect.left + rect.width / 2;
          header.querySelectorAll('th').forEach(t => t.classList.remove('drop-target-left', 'drop-target-right'));
          if (e.clientX < mid) th.classList.add('drop-target-left');
          else th.classList.add('drop-target-right');
        };
        th.ondrop = (e) => {
          e.preventDefault();
          const targetCol = th.dataset.col;
          if (this.draggingColumn !== targetCol) {
            this.reorderColumns(this.draggingColumn, targetCol, th.classList.contains('drop-target-left'));
          }
        };
      });
    }

    reorderColumns(draggedId, targetId, isLeft) {
      const draggedIdx = this.columns.findIndex(c => c.id === draggedId);
      const draggedCol = this.columns.splice(draggedIdx, 1)[0];
      let targetIdx = this.columns.findIndex(c => c.id === targetId);
      if (!isLeft) targetIdx++;
      this.columns.splice(targetIdx, 0, draggedCol);
      this.savePrefs();
      this.render();
    }

    renderRows() {
      const body = document.getElementById(`${this.id}-body`);
      const pageData = this.getPageData();

      if (pageData.length === 0) {
        body.innerHTML = `<tr><td colspan="${this.columns.length + 1}" class="text-center py-5 text-muted">No se encontraron resultados</td></tr>`;
        return;
      }

      body.innerHTML = pageData.map((row, idx) => `
        <tr data-id="${row.id}" data-idx="${idx}" class="${this.selection.has(row.id) ? 'row-selected' : ''}">
          <td style="text-align: center;">
            <input type="checkbox" class="row-checkbox" ${this.selection.has(row.id) ? 'checked' : ''}>
          </td>
          ${this.columns.filter(c => c.visible !== false).map(col => {
            const val = row[col.id];
            let display = '';
            const cellRenderer = col.render || col.renderCell;
            if (cellRenderer) {
              display = cellRenderer(val, row);
            } else {
              display = val === null || val === undefined ? '' : val;
              if (col.type === 'date' && val) display = new Date(val).toLocaleDateString();
              if (col.type === 'badge' && val) display = `<span class="badge bg-light text-dark border">${val}</span>`;
            }
            return `<td style="text-align: ${col.align || 'left'}">${display}</td>`;
          }).join('')}
        </tr>
      `).join('');

      // Row Events
      body.querySelectorAll('tr[data-id]').forEach(tr => {
        const id = Number(tr.dataset.id);
        const idx = Number(tr.dataset.idx);

        tr.onclick = (e) => {
          if (e.target.type === 'checkbox') {
             this.toggleSelection(id, idx, e.shiftKey, e.ctrlKey || e.metaKey);
             return;
          }
          this.handleRowClick(id, idx, e.shiftKey, e.ctrlKey || e.metaKey);
          if (this.onRowClick) this.onRowClick(rowFromId(id, pageData));
        };

        tr.ondblclick = () => {
          if (this.onRowDblClick) this.onRowDblClick(rowFromId(id, pageData));
        };
      });

      function rowFromId(id, data) { return data.find(r => r.id === id); }
    }

    handleRowClick(id, idx, shift, ctrl) {
      if (!ctrl && !shift) {
        this.selection.clear();
        this.selection.add(id);
      } else if (ctrl) {
        if (this.selection.has(id)) this.selection.delete(id);
        else this.selection.add(id);
      } else if (shift && this.lastSelectedIndex !== -1) {
        const start = Math.min(this.lastSelectedIndex, idx);
        const end = Math.max(this.lastSelectedIndex, idx);
        const pageData = this.getPageData();
        for (let i = start; i <= end; i++) {
          this.selection.add(pageData[i].id);
        }
      }
      this.lastSelectedIndex = idx;
      this.updateSelectionUI();
    }

    toggleSelection(id, idx, shift, ctrl) {
      if (this.selection.has(id)) this.selection.delete(id);
      else this.selection.add(id);
      this.lastSelectedIndex = idx;
      this.updateSelectionUI();
    }

    clearSelection() {
      this.selection.clear();
      this.updateSelectionUI();
    }

    updateSelectionUI() {
      const count = this.selection.size;
      const btnDelete = document.getElementById(`${this.id}-btn-delete`);
      const btnEdit = document.getElementById(`${this.id}-btn-edit`);
      const info = document.getElementById(`${this.id}-selection-info`);
      const countText = document.getElementById(`${this.id}-count`);
      const selectAll = document.getElementById(`${this.id}-select-all`);

      if (btnDelete) btnDelete.disabled = count === 0;
      if (btnEdit) btnEdit.disabled = count !== 1;
      if (info) info.classList.toggle('active', count > 0);
      if (countText) countText.textContent = `${count} seleccionado${count !== 1 ? 's' : ''}`;
      
      const pageData = this.getPageData();
      const allSelected = pageData.length > 0 && pageData.every(row => this.selection.has(row.id));
      if (selectAll) selectAll.checked = allSelected;

      // Actualizar clases de filas
      const body = document.getElementById(`${this.id}-body`);
      if (body) {
        body.querySelectorAll('tr').forEach(tr => {
          const id = Number(tr.dataset.id);
          const isSel = this.selection.has(id);
          tr.classList.toggle('row-selected', isSel);
          const cb = tr.querySelector('.row-checkbox');
          if (cb) cb.checked = isSel;
        });
      }
    }

    getPageData() {
      const start = (this.currentPage - 1) * this.pageSize;
      return this.data.slice(start, start + this.pageSize);
    }

    renderFooter() {
      const footer = document.getElementById(`${this.id}-footer`);
      const total = this.data.length;
      const totalPages = Math.ceil(total / this.pageSize) || 1;
      const startIdx = total === 0 ? 0 : (this.currentPage - 1) * this.pageSize + 1;
      const endIdx = Math.min(this.currentPage * this.pageSize, total);

      footer.innerHTML = `
        <div>Mostrando <span class="fw-bold">${startIdx}-${endIdx}</span> de <span class="fw-bold">${total}</span> registros</div>
        <div class="pagination-controls">
          <select class="form-select form-select-sm" style="width: 120px;" id="${this.id}-page-size">
            <option value="10" ${this.pageSize === 10 ? 'selected' : ''}>10 / pág</option>
            <option value="25" ${this.pageSize === 25 ? 'selected' : ''}>25 / pág</option>
            <option value="50" ${this.pageSize === 50 ? 'selected' : ''}>50 / pág</option>
            <option value="100" ${this.pageSize === 100 ? 'selected' : ''}>100 / pág</option>
          </select>
          <button class="page-btn" id="${this.id}-page-prev" ${this.currentPage === 1 ? 'disabled' : ''}><i class="bi bi-chevron-left"></i></button>
          <span>Página ${this.currentPage} de ${totalPages}</span>
          <button class="page-btn" id="${this.id}-page-next" ${this.currentPage === totalPages ? 'disabled' : ''}><i class="bi bi-chevron-right"></i></button>
        </div>
      `;

      document.getElementById(`${this.id}-page-size`).onchange = (e) => {
        this.pageSize = Number(e.target.value);
        this.currentPage = 1;
        this.savePrefs();
        this.render();
      };
      document.getElementById(`${this.id}-page-prev`).onclick = () => { this.currentPage--; this.render(); };
      document.getElementById(`${this.id}-page-next`).onclick = () => { this.currentPage++; this.render(); };
    }

    attachResizeEvents() {
      const wrapper = document.getElementById(`${this.id}-wrapper`);
      wrapper.onmousemove = (e) => {
        if (!this.resizingColumn) return;
        const colId = this.resizingColumn.dataset.col;
        const col = this.columns.find(c => c.id === colId);
        const diff = e.clientX - this.startX;
        const newWidth = Math.max(50, this.startWidth + diff);
        this.resizingColumn.parentElement.style.width = newWidth + 'px';
        col.width = newWidth + 'px';
      };

      wrapper.onmouseup = () => {
        if (this.resizingColumn) {
          this.resizingColumn = null;
          this.savePrefs();
        }
      };

      this.container.querySelectorAll('.resize-handle').forEach(handle => {
        handle.onmousedown = (e) => {
          e.stopPropagation();
          this.resizingColumn = handle;
          this.startX = e.clientX;
          this.startWidth = handle.parentElement.offsetWidth;
        };
      });
    }
  }

  function getGanttSeparators() {
    if (
      Array.isArray(window.GANTT_GROUP_SEPARATORS) &&
      window.GANTT_GROUP_SEPARATORS.every((s) => typeof s === "string")
    ) {
      return window.GANTT_GROUP_SEPARATORS;
    }
    return [" - ", " — ", " | ", ":"];
  }

  function getGanttGroupKey(title) {
    const t = String(title || "").trim();
    if (!t) return "(Sin título)";
    const seps = getGanttSeparators();
    for (const sep of seps) {
      const idx = t.indexOf(sep);
      if (idx > 0) {
        return t.slice(0, idx).trim();
      }
    }
    return t;
  }

  const GANTT_GROUP_COLORS = [
    { light: "rgba(79, 70, 229, 0.32)", dark: "rgba(99, 102, 241, 0.68)", border: "rgba(129, 140, 248, 0.95)" },
    { light: "rgba(14, 165, 233, 0.33)", dark: "rgba(6, 182, 212, 0.70)", border: "rgba(56, 189, 248, 0.90)" },
    { light: "rgba(16, 185, 129, 0.28)", dark: "rgba(34, 197, 94, 0.72)", border: "rgba(34, 197, 94, 0.95)" },
    { light: "rgba(236, 72, 153, 0.24)", dark: "rgba(219, 39, 119, 0.62)", border: "rgba(236, 72, 153, 0.90)" },
    { light: "rgba(234, 179, 8, 0.26)", dark: "rgba(234, 179, 8, 0.66)", border: "rgba(251, 191, 36, 0.92)" },
  ];

  function getGanttColorForKey(key) {
    if (!key) return GANTT_GROUP_COLORS[0];
    const idx = Math.abs(
      Array.from(key).reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
    ) % GANTT_GROUP_COLORS.length;
    return GANTT_GROUP_COLORS[idx];
  }

  function groupEventsForGantt(evts) {
    const map = new Map();
    evts.forEach((ev) => {
      const key = getGanttGroupKey(ev.title);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(ev);
    });
    // Orden consistente dentro de cada grupo: más moderno -> más antiguo
    map.forEach((arr) => arr.sort((a, b) => b.start - a.start));
    return map;
  }

  function hasIcsUrl() {
    return (
      typeof window.ICS_URL === "string" && window.ICS_URL.trim().length > 0
    );
  }

  function ensureConfig() {
    const hasApiKey =
      typeof window.GOOGLE_API_KEY === "string" &&
      window.GOOGLE_API_KEY.trim().length > 0;
    const hasCalendarId =
      typeof window.CALENDAR_ID === "string" &&
      window.CALENDAR_ID.trim().length > 0;

    const canUseApi = hasApiKey && hasCalendarId;
    const canUseIcs = hasIcsUrl();

    if (!canUseApi && !canUseIcs) {
      throw new Error(
        "Falta configuración en config.js. Debes indicar GOOGLE_API_KEY y CALENDAR_ID, o bien una URL ICS en ICS_URL."
      );
    }
  }

  function setStatus(message, type = "info") {
    statusMessageEl.textContent = message || "";
    statusMessageEl.className = `status-message ${type}`;
  }

  function showLoader(show) {
    loaderEl.classList.toggle("hidden", !show);
  }

  function toISODateKey(date) {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function getMadridHolidaysSet() {
    if (!Array.isArray(window.MADRID_HOLIDAYS)) return new Set();
    return new Set(
      window.MADRID_HOLIDAYS
        .filter((d) => typeof d === "string")
        .map((d) => d.trim())
        .filter(Boolean)
    );
  }

  function parseEventDate(eventDate) {
    if (!eventDate) return null;
    if (eventDate.dateTime) {
      return new Date(eventDate.dateTime);
    }
    if (eventDate.date) {
      // fecha de día completo, interpretamos como hora local 00:00
      return new Date(eventDate.date + "T00:00:00");
    }
    return null;
  }

  function parseIcsDate(value) {
    if (!value) return null;
    // Ejemplos:
    //  - 20250313
    //  - 20250313T093000Z
    //  - 20250313T093000
    const dateOnlyMatch = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
    if (dateOnlyMatch) {
      const [, y, m, d] = dateOnlyMatch;
      return {
        date: new Date(Number(y), Number(m) - 1, Number(d)),
        isAllDay: true,
      };
    }

    const dateTimeMatch =
      /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
    if (dateTimeMatch) {
      const [, y, m, d, hh, mm, ss, z] = dateTimeMatch;
      if (z === "Z") {
        const iso = `${y}-${m}-${d}T${hh}:${mm}:${ss}Z`;
        return { date: new Date(iso), isAllDay: false };
      }
      const local = new Date(
        Number(y),
        Number(m) - 1,
        Number(d),
        Number(hh),
        Number(mm),
        Number(ss)
      );
      return { date: local, isAllDay: false };
    }

    const parsed = new Date(value);
    if (!isNaN(parsed.getTime())) {
      return { date: parsed, isAllDay: false };
    }
    return null;
  }

  function normalizeIcsEvents(icsText) {
    // Unir líneas continuadas (empiezan por espacio según RFC 5545)
    const rawLines = icsText.split(/\r?\n/);
    const lines = [];
    rawLines.forEach((line) => {
      if (/^[ \t]/.test(line) && lines.length > 0) {
        lines[lines.length - 1] += line.slice(1);
      } else {
        lines.push(line);
      }
    });

    const eventsIcs = [];
    let current = null;

    lines.forEach((line) => {
      if (line.startsWith("BEGIN:VEVENT")) {
        current = {};
        return;
      }
      if (line.startsWith("END:VEVENT")) {
        if (current && current.DTSTART) {
          const startInfo = parseIcsDate(current.DTSTART);
          if (!startInfo) return;
          const endInfo = current.DTEND ? parseIcsDate(current.DTEND) : null;

          eventsIcs.push({
            id: current.UID || `${current.DTSTART}-${current.SUMMARY || ""}`,
            title: current.SUMMARY || "(Sin título)",
            description: current.DESCRIPTION || "",
            location: current.LOCATION || "",
            start: startInfo.date,
            end: endInfo ? endInfo.date : startInfo.date,
            htmlLink: current.URL || "",
            isAllDay: !!startInfo.isAllDay,
            sourceId: current["X-SOURCE-ID"] ? (isNaN(current["X-SOURCE-ID"]) ? current["X-SOURCE-ID"] : Number(current["X-SOURCE-ID"])) : null
          });
        }
        current = null;
        return;
      }
      if (!current) return;

      const idx = line.indexOf(":");
      if (idx === -1) return;
      const keyPart = line.slice(0, idx);
      const valuePart = line.slice(idx + 1);
      const key = keyPart.split(";")[0];
      current[key] = valuePart;
    });

    return eventsIcs
      .filter(Boolean)
      .sort((a, b) => b.start - a.start);
  }

  function normalizeEvents(apiEvents) {
    return apiEvents
      .map((ev) => {
        const start = parseEventDate(ev.start);
        const end = parseEventDate(ev.end) || start;
        if (!start) return null;
        return {
          id: ev.id,
          title: ev.summary || "(Sin título)",
          description: ev.description || "",
          location: ev.location || "",
          start,
          end,
          htmlLink: ev.htmlLink || "",
          isAllDay: !!(ev.start && ev.start.date && !ev.start.dateTime),
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.start - a.start);
  }

  function getTimeRange() {
    const now = new Date();
    const start = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      0,
      0,
      0
    );
    const end = new Date(start);
    end.setMonth(end.getMonth() + DEFAULT_MONTH_RANGE);
    return { start, end };
  }

  async function fetchEventsFromApi() {
    const { start, end } = getTimeRange();

    const params = new URLSearchParams({
      key: window.GOOGLE_API_KEY,
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      showDeleted: "false",
      maxResults: "2500",
    });

    const baseUrl = "https://www.googleapis.com/calendar/v3/calendars";
    const encodedCalendarId = encodeURIComponent(window.CALENDAR_ID);
    const url = `${baseUrl}/${encodedCalendarId}/events?${params.toString()}`;

    showLoader(true);
    setStatus("Cargando eventos desde Google Calendar (API)…", "info");

    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(
          `Error HTTP ${res.status} al cargar eventos de Google Calendar`
        );
      }
      const data = await res.json();
      if (!Array.isArray(data.items)) {
        throw new Error("La respuesta de la API no contiene eventos.");
      }
      events = normalizeEvents(data.items);
      applyFilters();
      if (events.length === 0) {
        setStatus("No hay eventos en el rango de fechas configurado.", "info");
      } else {
        setStatus(
          `Eventos cargados correctamente (${events.length} eventos).`,
          "success"
        );
      }
    } catch (err) {
      console.error(err);
      setStatus(
        `No se han podido cargar los eventos: ${err.message}`,
        "error"
      );
    } finally {
      showLoader(false);
      // Re-enable force sync button and hide spinner if present
      if (typeof forceSyncBtn !== 'undefined' && forceSyncBtn) {
        forceSyncBtn.disabled = false;
        const spinner = forceSyncBtn.querySelector(".spinner-border");
        if (spinner) spinner.style.display = "none";
      }
    }
  }

  async function fetchEventsFromIcs() {
    showLoader(true);
    setStatus("Cargando eventos desde URL ICS…", "info");

    try {
      const res = await fetch(window.ICS_URL);
      if (!res.ok) {
        throw new Error(
          `Error HTTP ${res.status} al cargar el archivo ICS`
        );
      }
      const text = await res.text();
      events = normalizeIcsEvents(text);
      applyFilters();
      if (events.length === 0) {
        setStatus("No hay eventos en el archivo ICS.", "info");
      } else {
        setStatus(
          `Eventos cargados correctamente desde ICS (${events.length} eventos).`,
          "success"
        );
      }
    } catch (err) {
      console.error(err);
      setStatus(
        `No se han podido cargar los eventos desde ICS: ${err.message}`,
        "error"
      );
    } finally {
      showLoader(false);
      if (typeof forceSyncBtn !== 'undefined' && forceSyncBtn) {
        forceSyncBtn.disabled = false;
        const spinner = forceSyncBtn.querySelector(".spinner-border");
        if (spinner) spinner.style.display = "none";
      }
    }
  }

  async function fetchEvents() {
    ensureConfig();
    if (hasIcsUrl()) {
      await fetchEventsFromIcs();
    } else {
      await fetchEventsFromApi();
    }
  }

  function applyFilters() {
    const query = (searchInput.value || "").toLowerCase().trim();

    filteredEvents = events.filter((ev) => {
      // Filtro por texto
      const matchesSearch = !query ||
        ev.title.toLowerCase().includes(query) ||
        ev.description.toLowerCase().includes(query) ||
        ev.location.toLowerCase().includes(query);

      // Filtro por fuente
      const matchesSource = !ev.sourceId || activeSources.has(ev.sourceId);

      return matchesSearch && matchesSource;
    });

    renderCurrentView();
  }

  async function saveCalendarPrefs() {
    if (!currentUser || !currentUser.id) return;
    try {
      const raw = currentUser.interface_Prefs;
      const currentAllPrefs = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : {};
      
      currentAllPrefs.calendar_active_sources = Array.from(activeSources);
      
      const prefsStr = JSON.stringify(currentAllPrefs);
      currentUser.interface_Prefs = prefsStr;

      await fetch(`/apiserv/admin/accounts/${currentUser.id}/prefs`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interface_Prefs: prefsStr }),
      });
      console.log("[Calendar] Guardadas preferencias de fuentes:", currentAllPrefs.calendar_active_sources);
    } catch (e) {
      console.error("[Calendar] Error guardando preferencias de fuentes", e);
    }
  }

  function renderSourceFilters() {
    const container = document.getElementById("sourceFilters");
    if (!container) return;
    container.innerHTML = "";

    window.SOURCES.forEach(source => {
      const item = document.createElement("label");
      item.className = "source-filter-item";
      if (!activeSources.has(source.id)) item.classList.add("is-inactive");

      item.innerHTML = `
        <input type="checkbox" value="${source.id}" ${activeSources.has(source.id) ? "checked" : ""}>
        <span class="custom-checkbox" style="--check-color: ${source.color || "#22c55e"}"></span>
        <span class="source-color-dot" style="background-color: ${source.color || "#22c55e"}"></span>
        <span class="ms-1">${source.label}</span>
      `;

      item.querySelector("input").addEventListener("change", (e) => {
        if (e.target.checked) {
          activeSources.add(source.id);
          item.classList.remove("is-inactive");
        } else {
          activeSources.delete(source.id);
          item.classList.add("is-inactive");
        }
        applyFilters();
        if (currentUser) saveCalendarPrefs();
      });

      container.appendChild(item);
    });
  }

  function clearView() {
    viewContainer.innerHTML = "";
  }

  function formatDateLong(date) {
    return date.toLocaleDateString("es-ES", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  }

  function getSourceConfig(sourceId) {
    if (!window.SOURCES) return null;
    return window.SOURCES.find((s) => s.id === sourceId) || null;
  }

  function formatTimeRange(ev) {
    if (ev.isAllDay) return "Todo el día";
    const opts = { hour: "2-digit", minute: "2-digit" };
    const start = ev.start.toLocaleTimeString("es-ES", opts);
    const end = ev.end ? ev.end.toLocaleTimeString("es-ES", opts) : "";
    if (end && end !== start) return `${start} – ${end}`;
    return start;
  }

  function groupEventsByDate(evts) {
    const map = new Map();
    evts.forEach((ev) => {
      const key = toISODateKey(ev.start);
      if (!map.has(key)) {
        map.set(key, []);
      }
      map.get(key).push(ev);
    });
    return map;
  }

  function renderListView() {
    clearView();
    const wrapper = document.createElement("div");
    wrapper.className = "list-view";

    if (filteredEvents.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty-message";
      empty.textContent = "No hay eventos que cumplan el filtro actual.";
      wrapper.appendChild(empty);
      viewContainer.appendChild(wrapper);
      return;
    }

    const grouped = groupEventsByDate(filteredEvents);
    const sortedKeys = Array.from(grouped.keys()).sort().reverse();

    sortedKeys.forEach((dateKey) => {
      const dateEvents = grouped.get(dateKey);
      const date = dateEvents[0].start;

      const section = document.createElement("section");
      section.className = "day-group";

      const header = document.createElement("h2");
      header.className = "day-header";
      header.textContent = formatDateLong(date);
      section.appendChild(header);

      const list = document.createElement("div");
      list.className = "event-list";

      // UNIFICAR EVENTOS IGUALES (Mismo nombre en el mismo día)
      const unifiedEvents = [];
      const titleGroups = new Map();

      dateEvents.forEach(ev => {
        const titleKey = (ev.title || "").trim().toLowerCase();
        if (titleGroups.has(titleKey)) {
          const mainEv = titleGroups.get(titleKey);
          if (ev.sourceId && !mainEv.sourceIds.includes(ev.sourceId)) {
            mainEv.sourceIds.push(ev.sourceId);
          }
          if (ev.description && !mainEv.description.includes(ev.description.trim())) {
            mainEv.description += "\n" + ev.description;
          }
        } else {
          const newEv = { ...ev, sourceIds: ev.sourceId ? [ev.sourceId] : [] };
          titleGroups.set(titleKey, newEv);
          unifiedEvents.push(newEv);
        }
      });

      unifiedEvents.forEach((ev) => {
        const card = document.createElement("article");
        card.className = "event-card";

        // Color del borde basado en el primer origen
        if (ev.sourceIds.length > 0) {
          const firstSource = getSourceConfig(ev.sourceIds[0]);
          if (firstSource) {
            card.style.setProperty("--event-color", firstSource.color);
          }
        }

        const time = document.createElement("div");
        time.className = "event-time";
        time.textContent = formatTimeRange(ev);
        card.appendChild(time);

        const title = document.createElement("h3");
        title.className = "event-title";
        title.textContent = ev.title;
        card.appendChild(title);

        if (ev.location) {
          const loc = document.createElement("div");
          loc.className = "event-location";
          loc.textContent = ev.location;
          card.appendChild(loc);
        }

        // Mostrar todas las etiquetas de origen vinculadas horizontalmente
        const badgeContainer = document.createElement("div");
        badgeContainer.className = "source-badges-container";

        ev.sourceIds.forEach(sid => {
          const sourceCfg = getSourceConfig(sid);
          if (sourceCfg) {
            const badge = document.createElement("div");
            badge.className = "event-meta";
            badge.style.color = sourceCfg.color;
            badge.innerHTML = `<i class="bi bi-tag-fill me-1"></i>${sourceCfg.label}`;
            badgeContainer.appendChild(badge);
          }
        });
        card.appendChild(badgeContainer);

        if (ev.description) {
          const desc = document.createElement("p");
          desc.className = "event-description";
          desc.textContent = ev.description;
          card.appendChild(desc);
        }

        if (ev.htmlLink) {
          const link = document.createElement("a");
          link.href = ev.htmlLink;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.className = "event-link";
          link.textContent = "Ver en Google Calendar";
          card.appendChild(link);
        }

        // Botón de suscripción
        const subscribeBtn = document.createElement("button");
        subscribeBtn.className = "btn btn-sm btn-outline-light subscribe-btn";
        // subscribeBtn.style.padding = "0.15rem 0.4rem";
        // subscribeBtn.style.fontSize = "0.75rem";
        subscribeBtn.innerHTML = '<i class="bi bi-bell"></i> Suscribirme';
        subscribeBtn.title = "Suscribirse a notificaciones";
        subscribeBtn.addEventListener("click", () => openSubscribeModal(ev, true, false));
        card.appendChild(subscribeBtn);

        list.appendChild(card);
      });

      section.appendChild(list);
      wrapper.appendChild(section);
    });

    viewContainer.appendChild(wrapper);
  }

  function getMonthGrid(date) {
    const year = date.getFullYear();
    const month = date.getMonth();

    const firstOfMonth = new Date(year, month, 1);
    const lastOfMonth = new Date(year, month + 1, 0);

    const startDay = firstOfMonth.getDay(); // Sunday is 0

    const days = [];
    const totalDays = lastOfMonth.getDate();

    for (let i = 0; i < startDay; i++) {
      days.push(null);
    }

    for (let d = 1; d <= totalDays; d++) {
      days.push(new Date(year, month, d));
    }

    while (days.length % 7 !== 0) {
      days.push(null);
    }

    const weeks = [];
    for (let i = 0; i < days.length; i += 7) {
      weeks.push(days.slice(i, i + 7));
    }
    return weeks;
  }

  function renderMonthView() {
    clearView();
    const wrapper = document.createElement("div");
    wrapper.className = "month-view";

    const header = document.createElement("div");
    header.className = "month-header";

    const monthLabel = document.createElement("h2");
    // Format: Month Day, Year (to match screenshot exactly)
    const options = { month: 'long', day: 'numeric', year: 'numeric' };
    monthLabel.textContent = currentMonthDate.toLocaleDateString("en-US", options);
    header.appendChild(monthLabel);

    const nav = document.createElement("div");
    nav.className = "month-nav";

    const prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.innerHTML = '<i class="bi bi-caret-left-fill"></i>';
    prevBtn.className = "btn btn-link text-muted p-0 me-2";
    prevBtn.addEventListener("click", () => {
      currentMonthDate = new Date(
        currentMonthDate.getFullYear(),
        currentMonthDate.getMonth() - 1,
        1
      );
      renderMonthView();
    });

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.innerHTML = '<i class="bi bi-caret-right-fill"></i>';
    nextBtn.className = "btn btn-link text-muted p-0";
    nextBtn.addEventListener("click", () => {
      currentMonthDate = new Date(
        currentMonthDate.getFullYear(),
        currentMonthDate.getMonth() + 1,
        1
      );
      renderMonthView();
    });

    nav.appendChild(prevBtn);
    nav.appendChild(nextBtn);
    header.appendChild(nav);
    wrapper.appendChild(header);

    const weekdays = document.createElement("div");
    weekdays.className = "month-weekdays";
    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].forEach((label) => {
      const el = document.createElement("div");
      el.className = "weekday";
      el.textContent = label;
      weekdays.appendChild(el);
    });
    wrapper.appendChild(weekdays);

    const grid = document.createElement("div");
    grid.className = "month-grid";

    const grouped = groupEventsByDate(filteredEvents);
    const todayStr = toISODateKey(new Date());

    const weeks = getMonthGrid(currentMonthDate);
    weeks.forEach((week) => {
      week.forEach((day) => {
        const cell = document.createElement("div");
        cell.className = "month-cell";

        if (!day) {
          cell.classList.add("is-empty");
          grid.appendChild(cell);
          return;
        }

        const dateKey = toISODateKey(day);
        if (dateKey === todayStr) {
          cell.classList.add("today");
        }

        if (day.getMonth() !== currentMonthDate.getMonth()) {
          cell.classList.add("other-month");
        }

        const dayEvents = grouped.get(dateKey) || [];

        const dayNumber = document.createElement("div");
        dayNumber.className = "day-number";
        dayNumber.textContent = String(day.getDate()).padStart(2, '0');
        cell.appendChild(dayNumber);

        const eventsContainer = document.createElement("div");
        eventsContainer.className = "day-events";

        const maxVisible = 2; // Match screenshot style with more link
        dayEvents.slice(0, maxVisible).forEach((ev) => {
          const pill = document.createElement("div");
          pill.className = "day-event-pill";
          pill.textContent = ev.title;

          const sourceCfg = getSourceConfig(ev.sourceId);
          if (sourceCfg) {
            pill.style.backgroundColor = sourceCfg.color;
          }

          eventsContainer.appendChild(pill);
        });

        if (dayEvents.length > maxVisible) {
          const more = document.createElement("div");
          more.className = "day-event-more text-center mt-1";
          more.innerHTML = `<a href="#" class="text-muted small text-decoration-none">More</a>`;
          more.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            openDayDetailModal(day, dayEvents);
          });
          eventsContainer.appendChild(more);
        }

        cell.appendChild(eventsContainer);

        if (dayEvents.length > 0) {
          cell.classList.add("has-events");
          cell.addEventListener("click", () => {
            openDayDetailModal(day, dayEvents);
          });
        }
        grid.appendChild(cell);
      });
    });
    wrapper.appendChild(grid);
    viewContainer.appendChild(wrapper);
  }

  function openDayDetailModal(day, dayEvents) {
    const overlay = document.createElement("div");
    overlay.className = "custom-modal-overlay";
    document.body.classList.add("modal-open");
    document.body.style.overflow = "hidden";

    const modal = document.createElement("div");
    modal.className = "custom-modal";

    const header = document.createElement("header");
    header.className = "custom-modal-header";
    const title = document.createElement("h3");
    title.textContent = formatDateLong(day);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "custom-modal-close";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => {
      document.body.removeChild(overlay);
      document.body.classList.remove("modal-open");
      document.body.style.overflow = "";
    });

    header.appendChild(title);
    header.appendChild(closeBtn);
    modal.appendChild(header);

    const body = document.createElement("div");
    body.className = "custom-modal-body";

    dayEvents.forEach((ev) => {
      const card = document.createElement("article");
      card.className = "event-card";

      const sourceCfg = getSourceConfig(ev.sourceId);
      if (sourceCfg) {
        card.style.setProperty("--event-color", sourceCfg.color);
      }

      const header = document.createElement("div");
      header.style.display = "flex";
      header.style.justifyContent = "space-between";
      header.style.alignItems = "center";
      header.style.gap = "1rem";

      const time = document.createElement("div");
      time.className = "event-time";
      time.textContent = formatTimeRange(ev);
      header.appendChild(time);

      if (ev.isAllDay) {
        const allDay = document.createElement("span");
        allDay.className = "event-badge";
        allDay.textContent = "Todo el día";
        allDay.style.background = "rgba(34, 197, 94, 0.25)";
        allDay.style.color = "#d1fae5";
        allDay.style.padding = "0.1rem 0.4rem";
        allDay.style.borderRadius = "999px";
        allDay.style.fontSize = "0.75rem";
        allDay.style.fontWeight = "600";
        header.appendChild(allDay);
      }

      const evTitle = document.createElement("h4");
      evTitle.className = "event-title";
      evTitle.textContent = ev.title;

      const info = document.createElement("div");
      info.className = "event-detail-info";

      const dateNode = document.createElement("div");
      dateNode.className = "event-meta";
      dateNode.textContent = `Fecha: ${formatDateLong(ev.start)}${ev.end && ev.end.getTime() !== ev.start.getTime() ? ` — ${formatDateLong(ev.end)}` : ""}`;
      info.appendChild(dateNode);

      if (ev.location) {
        const loc = document.createElement("div");
        loc.className = "event-meta";
        loc.textContent = `Ubicación: ${ev.location}`;
        info.appendChild(loc);
      }

      if (sourceCfg) {
        const badge = document.createElement("div");
        badge.className = "event-meta mt-1";
        badge.style.color = sourceCfg.color;
        badge.innerHTML = `<i class="bi bi-tag-fill me-1"></i>${sourceCfg.label}`;
        info.appendChild(badge);
      }

      if (ev.htmlLink) {
        const link = document.createElement("a");
        link.href = ev.htmlLink;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.className = "event-link";
        link.textContent = "Ver en Google Calendar";
        info.appendChild(link);
      }

      const subscribeBtn = document.createElement("button");
      subscribeBtn.className = "btn btn-sm btn-outline-light";
      subscribeBtn.style.marginTop = "0.35rem";
      subscribeBtn.textContent = "Suscribirse";
      subscribeBtn.addEventListener("click", () => {
        document.body.removeChild(overlay);
        document.body.classList.remove("modal-open");
        document.body.style.overflow = "";
        openSubscribeModal(ev, true, false);
      });
      info.appendChild(subscribeBtn);

      card.appendChild(header);
      card.appendChild(evTitle);
      card.appendChild(info);

      if (ev.description) {
        const desc = document.createElement("p");
        desc.className = "event-description";
        desc.textContent = ev.description;
        card.appendChild(desc);
      } else {
        const desc = document.createElement("p");
        desc.className = "event-description";
        desc.style.fontStyle = "italic";
        desc.textContent = "Sin notas adicionales.";
        card.appendChild(desc);
      }

      body.appendChild(card);
    });

    modal.appendChild(body);
    overlay.appendChild(modal);

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        document.body.removeChild(overlay);
        document.body.classList.remove("modal-open");
        document.body.style.overflow = "";
      }
    });

    document.body.appendChild(overlay);
  }

  function renderTimelineView() {
    clearView();
    const wrapper = document.createElement("div");
    wrapper.className = "timeline-view";

    if (filteredEvents.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty-message";
      empty.textContent = "No hay eventos que cumplan el filtro actual.";
      wrapper.appendChild(empty);
      viewContainer.appendChild(wrapper);
      return;
    }

    const grouped = groupEventsByDate(filteredEvents);
    const sortedKeys = Array.from(grouped.keys()).sort().reverse();

    sortedKeys.forEach((dateKey) => {
      const dateEvents = grouped.get(dateKey);
      const date = dateEvents[0].start;

      const node = document.createElement("section");
      node.className = "timeline-node";

      const dateBadge = document.createElement("div");
      dateBadge.className = "timeline-date";
      dateBadge.textContent = formatDateLong(date);

      const line = document.createElement("div");
      line.className = "timeline-line";

      const eventsRow = document.createElement("div");
      eventsRow.className = "timeline-events-row";

      // UNIFICAR EVENTOS IGUALES (Mismo nombre en el mismo día)
      const unifiedEvents = [];
      const titleGroups = new Map();

      dateEvents.forEach(ev => {
        const titleKey = (ev.title || "").trim().toLowerCase();
        if (titleGroups.has(titleKey)) {
          const mainEv = titleGroups.get(titleKey);
          if (ev.sourceId && !mainEv.sourceIds.includes(ev.sourceId)) {
            mainEv.sourceIds.push(ev.sourceId);
          }
          if (ev.description && !mainEv.description.includes(ev.description.trim())) {
            mainEv.description += "\n" + ev.description;
          }
        } else {
          const newEv = { ...ev, sourceIds: ev.sourceId ? [ev.sourceId] : [] };
          titleGroups.set(titleKey, newEv);
          unifiedEvents.push(newEv);
        }
      });

      unifiedEvents.forEach((ev) => {
        const card = document.createElement("article");
        card.className = "timeline-event-card";

        if (ev.sourceIds.length > 0) {
          const firstSource = getSourceConfig(ev.sourceIds[0]);
          if (firstSource) {
            card.style.setProperty("--event-color", firstSource.color);
          }
        }

        const time = document.createElement("div");
        time.className = "event-time";
        time.textContent = formatTimeRange(ev);
        card.appendChild(time);

        const title = document.createElement("h3");
        title.className = "event-title is-link";
        title.textContent = ev.title;
        title.title = "Hacer clic para suscribirse a este evento";
        title.addEventListener("click", (e) => {
          e.stopPropagation();
          openSubscribeModal(ev, true, false);
        });
        card.appendChild(title);

        if (ev.location) {
          const loc = document.createElement("div");
          loc.className = "event-location";
          loc.textContent = ev.location;
          card.appendChild(loc);
        }

        // Mostrar todas las etiquetas de origen vinculadas horizontalmente
        const badgeContainer = document.createElement("div");
        badgeContainer.className = "source-badges-container";

        ev.sourceIds.forEach(sid => {
          const sourceCfg = getSourceConfig(sid);
          if (sourceCfg) {
            const badge = document.createElement("div");
            badge.className = "event-meta";
            badge.style.color = sourceCfg.color;
            badge.innerHTML = `<i class="bi bi-tag-fill me-1"></i>${sourceCfg.label}`;
            badgeContainer.appendChild(badge);
          }
        });
        card.appendChild(badgeContainer);

        if (ev.description) {
          const desc = document.createElement("p");
          desc.className = "event-description";
          desc.textContent = ev.description;
          card.appendChild(desc);
        }

        eventsRow.appendChild(card);
      });

      node.appendChild(dateBadge);
      node.appendChild(line);
      node.appendChild(eventsRow);

      wrapper.appendChild(node);
    });

    viewContainer.appendChild(wrapper);
  }

  function startOfLocalDay(date) {
    const d = new Date(date);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);
  }

  function diffDays(start, end) {
    const dayMs = 24 * 60 * 60 * 1000;
    return Math.max(
      0,
      Math.round((startOfLocalDay(end) - startOfLocalDay(start)) / dayMs)
    );
  }

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function openEventDetailModal(ev) {
    const overlay = document.createElement("div");
    overlay.className = "custom-modal-overlay";
    document.body.classList.add("modal-open");
    document.body.style.overflow = "hidden";

    const modal = document.createElement("div");
    modal.className = "custom-modal";

    const header = document.createElement("header");
    header.className = "custom-modal-header";

    const title = document.createElement("h3");
    title.textContent = ev.title;

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "custom-modal-close";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => {
      document.body.removeChild(overlay);
      document.body.classList.remove("modal-open");
      document.body.style.overflow = "";
    });

    header.appendChild(title);
    header.appendChild(closeBtn);
    modal.appendChild(header);

    const body = document.createElement("div");
    body.className = "custom-modal-body";

    const info = document.createElement("div");
    info.className = "event-detail-info";

    const dateNode = document.createElement("div");
    dateNode.className = "event-meta";
    dateNode.textContent = `Fecha: ${formatDateLong(ev.start)}${ev.end && ev.end.getTime() !== ev.start.getTime() ? ` — ${formatDateLong(ev.end)}` : ""}`;
    info.appendChild(dateNode);

    const rangeNode = document.createElement("div");
    rangeNode.className = "event-meta";
    rangeNode.textContent = `Horario: ${formatTimeRange(ev)} ${ev.isAllDay ? "(Todo el día)" : ""}`;
    info.appendChild(rangeNode);

    const sourceCfg = getSourceConfig(ev.sourceId);
    if (sourceCfg) {
      const badge = document.createElement("div");
      badge.className = "event-meta mt-1";
      badge.style.color = sourceCfg.color;
      badge.innerHTML = `<i class="bi bi-tag-fill me-1"></i>${sourceCfg.label}`;
      info.appendChild(badge);
    }

    if (ev.location) {
      const loc = document.createElement("div");
      loc.className = "event-meta";
      loc.textContent = `Ubicación: ${ev.location}`;
      info.appendChild(loc);
    }

    if (ev.htmlLink) {
      const link = document.createElement("a");
      link.href = ev.htmlLink;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.className = "event-link";
      link.textContent = "Ver en Google Calendar";
      info.appendChild(link);
    }

    body.appendChild(info);

    if (ev.description) {
      const desc = document.createElement("p");
      desc.className = "event-description";
      desc.textContent = ev.description;
      body.appendChild(desc);
    } else {
      const desc = document.createElement("p");
      desc.className = "event-description";
      desc.style.fontStyle = "italic";
      desc.textContent = "Sin notas adicionales.";
      body.appendChild(desc);
    }

    if (ev.htmlLink) {
      const link = document.createElement("a");
      link.href = ev.htmlLink;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.className = "event-link";
      link.textContent = "Ver en Google Calendar";
      body.appendChild(link);
    }

    const subscribeButton = document.createElement("button");
    subscribeButton.className = "btn btn-sm btn-outline-light";
    subscribeButton.textContent = "Suscribirse";
    subscribeButton.style.marginTop = "0.7rem";
    subscribeButton.addEventListener("click", () => {
      document.body.removeChild(overlay);
      document.body.classList.remove("modal-open");
      document.body.style.overflow = "";
      openSubscribeModal(ev, true, false);
    });
    body.appendChild(subscribeButton);

    modal.appendChild(body);
    overlay.appendChild(modal);

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        document.body.removeChild(overlay);
        document.body.classList.remove("modal-open");
        document.body.style.overflow = "";
      }
    });

    document.body.appendChild(overlay);
  }

  function computeGanttSegmentsForGroup(groupEvents, rangeStart, rangeEnd) {
    const totalDays = diffDays(rangeStart, rangeEnd) + 1;
    const segments = groupEvents
      .map((ev) => {
        const endEffective =
          ev.isAllDay && ev.end && ev.end > ev.start
            ? new Date(ev.end.getTime() - 1)
            : ev.end || ev.start;

        const startIdx = diffDays(rangeStart, ev.start);
        const endIdx = diffDays(rangeStart, endEffective);
        return {
          ev,
          startIdx,
          endIdx,
          left: clamp(startIdx, 0, totalDays - 1),
          right: clamp(endIdx, 0, totalDays - 1),
        };
      })
      .filter((s) => !(s.endIdx < 0 || s.startIdx > totalDays - 1))
      .map((s) => {
        const left = Math.min(s.left, s.right);
        const right = Math.max(s.left, s.right);
        return { ...s, left, right, widthDays: Math.max(1, right - left + 1) };
      })
      .sort((a, b) => a.left - b.left || a.right - b.right);

    // Asignación simple de lanes para evitar solapes
    const laneEnds = [];
    segments.forEach((seg) => {
      let lane = laneEnds.findIndex((end) => seg.left > end);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(seg.right);
      } else {
        laneEnds[lane] = seg.right;
      }
      seg.lane = lane;
    });

    return { segments, laneCount: Math.max(1, laneEnds.length), totalDays };
  }

  function renderGanttView() {
    clearView();
    // Rango dinámico: desde el primer evento hasta el último evento
    // (si no hay eventos, caemos al rango por defecto).
    let rangeStart = null;
    let rangeEnd = null;

    filteredEvents.forEach((ev) => {
      if (!(ev && ev.start instanceof Date) || isNaN(ev.start.getTime())) return;

      const endEffective =
        ev.isAllDay && ev.end && ev.end > ev.start
          ? new Date(ev.end.getTime() - 1)
          : ev.end || ev.start;

      if (!rangeStart || ev.start < rangeStart) rangeStart = ev.start;
      if (!rangeEnd || endEffective > rangeEnd) rangeEnd = endEffective;
    });

    if (!rangeStart || !rangeEnd) {
      const fallback = getTimeRange();
      rangeStart = fallback.start;
      rangeEnd = fallback.end;
    }

    rangeStart = startOfLocalDay(rangeStart);
    rangeEnd = startOfLocalDay(rangeEnd);
    const totalDays = diffDays(rangeStart, rangeEnd) + 1;

    const wrapper = document.createElement("div");
    wrapper.className = "gantt-view";

    if (filteredEvents.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty-message";
      empty.textContent = "No hay eventos que cumplan el filtro actual.";
      wrapper.appendChild(empty);
      viewContainer.appendChild(wrapper);
      return;
    }

    const grouped = groupEventsForGantt(filteredEvents);
    const groupKeys = Array.from(grouped.keys()).sort((a, b) =>
      a.localeCompare(b, "es-ES", { sensitivity: "base" })
    );

    const grid = document.createElement("div");
    grid.className = "gantt-grid";
    grid.style.setProperty("--gantt-total-days", String(totalDays));

    const header = document.createElement("div");
    header.className = "gantt-header";

    const headerLabel = document.createElement("div");
    headerLabel.className = "gantt-header-label";
    headerLabel.textContent = "Tipo";

    const headerTimeline = document.createElement("div");
    headerTimeline.className = "gantt-header-timeline";

    const daysRow = document.createElement("div");
    daysRow.className = "gantt-days";

    const holidays = getMadridHolidaysSet();
    const dayMeta = [];
    const today = startOfLocalDay(new Date());
    const todayKey = toISODateKey(today);

    for (let i = 0; i < totalDays; i++) {
      const day = new Date(rangeStart);
      day.setDate(day.getDate() + i);
      const dateKey = toISODateKey(day);
      const isWeekend = day.getDay() === 0 || day.getDay() === 6;
      const isHoliday = holidays.has(dateKey);
      const isToday = dateKey === todayKey;
      dayMeta.push({ isWeekend, isHoliday, isToday });
      const cell = document.createElement("div");
      cell.className = "gantt-day";
      if (isToday) cell.classList.add("is-today");
      if (isHoliday) cell.classList.add("is-holiday");
      else if (isWeekend) cell.classList.add("is-weekend");

      const weekday = document.createElement("div");
      weekday.className = "gantt-weekday";
      weekday.textContent = ["D", "L", "M", "X", "J", "V", "S"][day.getDay()];

      const dateText = document.createElement("div");
      dateText.className = "gantt-date";
      cell.textContent = day.toLocaleDateString("es-ES", {
        day: "2-digit",
        month: "2-digit",
      });
      dateText.textContent = day.toLocaleDateString("es-ES", {
        day: "2-digit",
        month: "2-digit",
      });

      cell.textContent = "";
      cell.appendChild(weekday);
      cell.appendChild(dateText);
      daysRow.appendChild(cell);
    }

    const weekRow = document.createElement("div");
    weekRow.className = "gantt-week-row";

    for (let i = 0; i < totalDays; i += 7) {
      const weekStart = new Date(rangeStart);
      weekStart.setDate(weekStart.getDate() + i);
      const daysInWeek = Math.min(7, totalDays - i);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + daysInWeek - 1);

      const weekCell = document.createElement("div");
      weekCell.className = "gantt-week-cell";
      weekCell.style.width = `calc(var(--gantt-day-width) * ${daysInWeek})`;
      weekCell.textContent = `${weekStart.toLocaleDateString("es-ES", { day: "numeric", month: "numeric" })} - ${weekEnd.toLocaleDateString("es-ES", { day: "numeric", month: "numeric" })}`;
      weekRow.appendChild(weekCell);
    }

    headerTimeline.appendChild(weekRow);
    headerTimeline.appendChild(daysRow);
    header.appendChild(headerLabel);
    header.appendChild(headerTimeline);
    grid.appendChild(header);

    groupKeys.forEach((key, idx) => {
      const groupEvents = grouped.get(key) || [];
      const { segments, laneCount } = computeGanttSegmentsForGroup(
        // Para layout es mejor ascendente por fecha
        groupEvents.slice().sort((a, b) => a.start - b.start),
        rangeStart,
        rangeEnd
      );

      const groupColor = getGanttColorForKey(key);

      const row = document.createElement("div");
      row.className = "gantt-row";
      row.classList.add(idx % 2 === 0 ? "is-even" : "is-odd");
      row.style.setProperty("--gantt-lanes", String(laneCount));

      const label = document.createElement("div");
      label.className = "gantt-row-label";
      label.textContent = key;
      label.style.setProperty("--gantt-row-color", groupColor.dark);

      const timeline = document.createElement("div");
      timeline.className = "gantt-row-timeline";

      const bg = document.createElement("div");
      bg.className = "gantt-bg";
      const bgRow = document.createElement("div");
      bgRow.className = "gantt-bg-row";
      dayMeta.forEach(({ isWeekend, isHoliday, isToday }) => {
        const c = document.createElement("div");
        c.className = "gantt-bg-day";
        if (isToday) c.classList.add("is-today");
        else if (isHoliday) c.classList.add("is-holiday");
        else if (isWeekend) c.classList.add("is-weekend");
        bgRow.appendChild(c);
      });
      bg.appendChild(bgRow);
      timeline.appendChild(bg);

      const bars = document.createElement("div");
      bars.className = "gantt-bars";

      segments.forEach((seg) => {
        const bar = document.createElement("button");
        bar.type = "button";
        bar.className = "gantt-bar";
        bar.style.setProperty("--gantt-left", String(seg.left));
        bar.style.setProperty("--gantt-width", String(seg.widthDays));
        bar.style.setProperty("--gantt-lane", String(seg.lane || 0));
        const sourceCfg = getSourceConfig(seg.ev.sourceId);
        const segColor = sourceCfg ? {
          light: sourceCfg.color + "55",
          dark: sourceCfg.color,
          border: sourceCfg.color
        } : getGanttColorForKey(key);

        bar.style.background = `linear-gradient(135deg, ${segColor.light}, ${segColor.dark})`;
        bar.style.borderColor = segColor.border;
        // bar.textContent = seg.ev.title; // Eliminado por petición del usuario
        bar.title = `${seg.ev.title}${sourceCfg ? ` [${sourceCfg.label}]` : ""}\n${formatDateLong(seg.ev.start)} · ${formatTimeRange(seg.ev)}${seg.ev.location ? `\n${seg.ev.location}` : ""}`;

        bar.addEventListener("click", () => openEventDetailModal(seg.ev));
        bars.appendChild(bar);
      });

      timeline.appendChild(bars);
      row.appendChild(label);
      row.appendChild(timeline);
      grid.appendChild(row);
    });

    wrapper.appendChild(grid);
    viewContainer.appendChild(wrapper);

    // Ajusta scroll inicial a la columna de hoy (lo más central posible)
    scrollGanttToToday();
    setTimeout(scrollGanttToToday, 120);
  }

  function scrollGanttToToday() {
    const ganttGrid = document.querySelector('.gantt-grid');
    const todayCell = document.querySelector('.gantt-day.is-today');
    if (!ganttGrid || !todayCell) return;

    const dayWidth = parseFloat(getComputedStyle(ganttGrid).getPropertyValue('--gantt-day-width')) || 34;
    const cells = Array.from(todayCell.parentElement.children);
    const dayIndex = cells.indexOf(todayCell);

    const visibleDays = Math.max(1, Math.floor(ganttGrid.clientWidth / dayWidth));
    const targetIndex = Math.max(0, dayIndex - Math.floor(visibleDays / 2));
    const targetScroll = targetIndex * dayWidth;

    if ('scrollTo' in ganttGrid) {
      ganttGrid.scrollTo({ left: targetScroll, behavior: 'smooth' });
    } else {
      ganttGrid.scrollLeft = targetScroll;
    }
  }

  function renderCurrentView() {
    switch (currentView) {
      case VIEW_LIST:
        renderListView();
        break;
      case VIEW_MONTH:
        renderMonthView();
        break;
      case VIEW_TIMELINE:
        renderTimelineView();
        break;
      case VIEW_GANTT:
        renderGanttView();
        break;
      case VIEW_INFOGRAPHIC:
        renderInfographicView();
        break;
      case VIEW_ACCOUNTS:
        renderAccountsView();
        break;
      case VIEW_ACCOUNT_EDIT:
        renderAccountEditView(currentEditRecordId);
        break;
      case VIEW_ENVIRONMENT_EDIT:
        renderEnvironmentEditView(currentEditRecordId);
        break;
      case VIEW_SUBSCRIPTION_EDIT:
        renderSubscriptionEditView(currentEditRecordId);
        break;
      case VIEW_SUBSCRIPTIONS:
        renderSubscriptionsView();
        break;
      case VIEW_AUDIT:
        renderAuditView();
        break;
      case VIEW_ENVIRONMENTS:
        renderEnvironmentsView();
        break;
      case VIEW_DOCUMENTS:
        renderDocumentsView();
        break;
      case VIEW_DOCUMENT_EDIT:
        renderDocumentEditView(currentEditRecordId);
        break;
      default:
        renderListView();
    }
  }

  function setView(newView, recordId = null, pushHistory = false) {
    if (pushHistory) {
      navigationHistory.push({ view: currentView, id: currentEditRecordId });
    }
    currentView = newView;
    currentEditRecordId = recordId;

    // Guardar solo vistas públicas o principales en localStorage
    const persistable = new Set([VIEW_LIST, VIEW_MONTH, VIEW_TIMELINE, VIEW_GANTT]);
    if (persistable.has(newView)) {
      try {
        window.localStorage.setItem("preferredView", String(newView));
      } catch { }
    }

    // Gestionar visibilidad de controles de calendario en el sidebar
    const calendarControls = document.getElementById('calendarControls');
    const isCalendarView = persistable.has(newView);
    if (calendarControls) {
      calendarControls.classList.toggle('d-none', !isCalendarView);
    }

    // Actualizar estado activo en el sidebar
    document.querySelectorAll('.app-sidebar .nav-link').forEach(link => {
      link.classList.remove('active');
      // El link de calendario es activo para cualquier vista de calendario
      if (isCalendarView && link.id === 'navCalendar') link.classList.add('active');
      // Otros links por coincidencia exacta de data-view o lógica específica
      if (link.dataset.view === newView) link.classList.add('active');
      if (newView === VIEW_ACCOUNT_EDIT && link.dataset.view === VIEW_ACCOUNTS) link.classList.add('active');
      if (newView === VIEW_ENVIRONMENT_EDIT && link.dataset.view === VIEW_ENVIRONMENTS) link.classList.add('active');
      if (newView === VIEW_SUBSCRIPTION_EDIT && link.dataset.view === VIEW_SUBSCRIPTIONS) link.classList.add('active');
      if (newView === VIEW_DOCUMENT_EDIT && link.dataset.view === VIEW_DOCUMENTS) link.classList.add('active');
    });

    // Actualizar botones de vista si estamos en calendario
    document.querySelectorAll('.view-button').forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.view === newView);
    });
    document.querySelectorAll('.view-tab').forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.view === newView);
    });

    renderCurrentView();
  }
  window.setView = setView;

  function goBack(defaultView) {
    const prev = navigationHistory.pop();
    if (prev) {
      setView(prev.view, prev.id);
    } else {
      setView(defaultView);
    }
  }
  window.goBack = goBack;

  function clearNavigationHistory() {
    navigationHistory = [];
  }

  function getInitialView() {
    const allowed = new Set([VIEW_LIST, VIEW_MONTH, VIEW_TIMELINE, VIEW_GANTT]);
    try {
      const stored = window.localStorage.getItem("preferredView");
      if (stored && allowed.has(stored)) return stored;
    } catch {
      // ignore
    }
    return VIEW_MONTH;
  }

  // --- Vista: Infografía Administrativa ---
  async function renderInfographicView() {
    viewContainer.innerHTML = `
      <div class="infographic-view">
        <div class="view-header mb-4 d-flex align-items-center justify-content-between flex-wrap gap-3">
          <div>
            <h2 class="view-title mb-1">Dashboard del Proyecto</h2>
            <p class="view-description mb-0 text-muted small">Documentación centralizada y seguimiento técnico (Solo Administradores)</p>
          </div>
          <div class="header-actions">
            <button id="btnSubscribeDashboard" class="btn btn-outline-primary btn-sm rounded-pill px-3">
              <i class="bi bi-bell-fill me-2"></i>Suscribirse a cambios
            </button>
          </div>
        </div>
        <div id="infographicLoading" class="text-center py-5">
          <div class="spinner-border text-primary" role="status"></div>
          <p class="mt-2 text-muted">Cargando datos del proyecto...</p>
        </div>
        <div id="infographicContent" class="infographic-container hidden">
          <!-- El contenido se cargará dinámicamente -->
        </div>
      </div>
    `;

    const subBtn = document.getElementById('btnSubscribeDashboard');
    if (subBtn) {
      subBtn.addEventListener('click', () => {
        openSubscribeModal(null, false, true);
      });
    }

    try {
      const res = await fetch('/apiserv/admin/infographic-data' + window.location.search);
      if (!res.ok) throw new Error('No autorizado o error al cargar datos');
      const data = await res.json();
      renderInfographicContent(data.links, data.docContent, data.docUrl);
    } catch (err) {
      document.getElementById('infographicLoading').innerHTML = `
        <div class="alert alert-warning">
          <h5><i class="bi bi-shield-lock-fill me-2"></i>Acceso Restringido</h5>
          <p class="mb-0">Esta sección requiere una sesión de administrador activa. Por favor, inicia sesión para ver el contenido.</p>
        </div>
      `;
    } finally {
      const loading = document.getElementById('infographicLoading');
      if (loading) {
        loading.classList.add('hidden-dashboard');
        loading.classList.add('d-none');
      }
    }
  }

  function renderInfographicContent(links, docContent, docUrl) {
    const container = document.getElementById('infographicContent');
    const loading = document.getElementById('infographicLoading');

    if (!container || !loading) return;

    // Forzar ocultar spinner
    loading.classList.add('hidden-dashboard');
    loading.classList.add('d-none');
    container.classList.remove('hidden');

    if ((!links || !Array.isArray(links) || links.length === 0) && !docContent) {
      container.innerHTML = `<div class="alert alert-info py-4 text-center">No hay datos de infografía configurados para este proyecto.</div>`;
      return;
    }

    // Agrupar y preparar categorías
    const categoriesMap = {};
    if (links && Array.isArray(links)) {
      links.forEach(link => {
        const cat = decodeHTMLEntities(link.category || "Otros");
        if (!categoriesMap[cat]) categoriesMap[cat] = [];
        categoriesMap[cat].push({
          ...link,
          label: decodeHTMLEntities(link.label),
          category: cat
        });
      });
    }

    const categoryIcons = {
      "Enlaces Principales": "bi-star-fill",
      "Planificación": "bi-calendar-check-fill",
      "Seguimiento Visual": "bi-camera-fill",
      "Documentación Técnica": "bi-file-earmark-text-fill",
      "Administración Económica": "bi-calculator-fill",
      "Legal/Ubicación": "bi-geo-alt-fill",
      "Otros": "bi-collection-fill"
    };

    const sortedCategories = Object.keys(categoriesMap).sort((a, b) => {
      if (a === "Enlaces Principales") return -1;
      if (b === "Enlaces Principales") return 1;
      return a.localeCompare(b);
    });

    let html = `<div class="infographic-grid-new">`;

    // 1. Renderizar tarjetas de enlaces primero
    sortedCategories.forEach(cat => {
      const icon = categoryIcons[cat] || "bi-folder2-open";
      html += `
        <div class="infographic-node-new">
          <div class="node-card">
            <div class="node-header">
              <i class="bi ${icon}"></i>
              <span>${cat}</span>
            </div>
            <div class="node-links">
              ${categoriesMap[cat].map(link => `
                <a href="${link.url}" class="node-link" target="_blank" rel="noopener noreferrer">
                  <div class="link-label">${link.label}</div>
                  <div class="link-desc">${link.desc || ''}</div>
                </a>
              `).join('')}
            </div>
          </div>
        </div>
      `;
    });

    // 2. Renderizar Resumen del Proyecto después
    if (docContent) {
      let formattedDoc = '';
      const decodedDoc = decodeHTMLEntities(docContent);
      const lines = decodedDoc.replace(/\r/g, '').split('\n');

      let inInitialList = false;
      lines.forEach(line => {
        const trimmed = line.trim();
        if (!trimmed) return;
        if (trimmed.startsWith('(') && trimmed.length < 100) { inInitialList = true; return; }
        if (inInitialList && (trimmed.endsWith(')') || trimmed.includes('..)'))) { inInitialList = false; return; }
        if (inInitialList) return;
        if (links && links.some(l => l.label.toLowerCase() === trimmed.toLowerCase())) return;

        if (trimmed.endsWith(':') || (trimmed.length < 50 && trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed))) {
          formattedDoc += `<h6 class="doc-section-title">${trimmed}</h6>`;
        } else if (trimmed.startsWith('*') || trimmed.startsWith('-')) {
          const content = trimmed.substring(1).trim();
          formattedDoc += `<div class="doc-list-item"><i class="bi bi-arrow-right-short"></i> <span>${content}</span></div>`;
        } else {
          formattedDoc += `<p class="doc-paragraph">${trimmed}</p>`;
        }
      });

      html += `
        <div class="infographic-resume-full">
          <div class="resume-header">
            <i class="bi bi-file-text"></i> 
            ${docUrl ? `<a href="${docUrl}" target="_blank" class="text-decoration-none"><span>Resumen del Proyecto</span></a>` : `<span>Resumen del Proyecto</span>`}
          </div>
          <div class="doc-text-body-full">${formattedDoc}</div>
        </div>
      `;
    }

    html += `</div>`;
    container.innerHTML = html;
    loading.classList.add('hidden');
    container.classList.remove('hidden');
  }
  function decodeHTMLEntities(text) {
    if (!text) return '';
    const textArea = document.createElement('textarea');
    textArea.innerHTML = text;
    return textArea.value;
  }

  // --- Vista: Gestión de Suscripciones (Integrada) ---
  async function renderSubscriptionsView() {
    await ensureAdminUser();
    viewContainer.innerHTML = `
      <div class="subscriptions-view container-fluid mt-2">
        <div class="view-header d-flex justify-content-between align-items-center mb-4">
          <div>
            <h2 class="view-title">Gestión de Suscripciones</h2>
            <p class="text-muted small">Administra los eventos y alertas de los usuarios registrados</p>
          </div>
        </div>
        <div id="subscriptions-table-container"></div>
      </div>
    `;

    const columns = [
      { id: 'name', label: 'Usuario', width: '200px', align: 'left' },
      { id: 'eventTitle', label: 'Evento', width: '250px', align: 'left' },
      { id: 'alertType', label: 'Alerta', width: '130px', align: 'center', type: 'badge' },
      { id: 'createdAt', label: 'Fecha', width: '120px', align: 'left', type: 'date' }
    ];

    if (currentUser && currentUser.isSuperuser) {
      columns.splice(1, 0, { id: 'environmentName', label: 'Entorno', width: '150px', align: 'left', type: 'badge' });
    }

    const table = await EnterpriseTable.create({
      id: 'subscriptions-table',
      columns: columns,
      onRowDblClick: (row) => setView(VIEW_SUBSCRIPTION_EDIT, row.id, true),
      onBulkDelete: async (ids) => {
        if (!confirm(`¿Seguro que quieres eliminar ${ids.length} suscripciones?`)) return;
        for (const id of ids) {
          await fetch(`/apiserv/admin/subscriptions/${id}`, { method: 'DELETE' });
        }
        renderSubscriptionsView();
      }
    });

    table.render(document.getElementById('subscriptions-table-container'));

    try {
      const res = await fetch('/apiserv/admin/subscriptions');
      if (!res.ok) throw new Error('No autorizado');
      const data = await res.json();
      
      // Formatear datos para visualización en tabla
      const formatted = data.map(sub => ({
        ...sub,
        name: `${sub.name || 'Sin nombre'} (${sub.email})`,
        alertType: sub.alertType === 'dashboard' ? 'Dashboard' : (sub.alertType === 'general' ? 'Total' : 'Específica')
      }));

      table.setData(formatted);
      // Guarda las prefs por defecto si es la primera vez que se carga con datos
      const raw = currentUser && currentUser.interface_Prefs;
      const existingPrefs = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
      if (!existingPrefs['subscriptions-table']) await table.initDefaultPrefs();
    } catch (err) {
      console.error(err);
      document.getElementById('subscriptions-table-container').innerHTML = `<div class="alert alert-danger">${err.message}</div>`;
    }
  }

  async function renderSubscriptionEditView(subId) {
    if (!subId) return setView(VIEW_SUBSCRIPTIONS);
    viewContainer.innerHTML = `<div class="text-center py-5"><div class="spinner-border"></div></div>`;
    try {
      const res = await fetch(`/apiserv/admin/subscriptions/${subId}`);
      if (!res.ok) throw new Error('Suscripción no encontrada');
      const sub = await res.json();

      viewContainer.innerHTML = `
        <div class="subscription-edit-page mt-4">
          <nav aria-label="breadcrumb" class="mb-4">
            <ol class="breadcrumb">
              <li class="breadcrumb-item"><a href="#" onclick="goBack(VIEW_SUBSCRIPTIONS)">Suscripciones</a></li>
              <li class="breadcrumb-item active">Editar Suscripción</li>
            </ol>
          </nav>
          <div class="d-flex align-items-center justify-content-between mb-4 border-bottom pb-3">
             <h2 class="mb-0">Editar Suscripción: <span class="text-primary">${sub.email}</span></h2>
          </div>
          <form id="editSubscriptionForm" class="row g-3">
            <div class="col-md-6">
              <label class="form-label fw-bold small">Usuario</label>
              <input type="text" class="form-control" value="${sub.name || sub.email}" readonly disabled>
            </div>
            <div class="col-md-6">
              <label class="form-label fw-bold small">Evento</label>
              <input type="text" class="form-control" value="${sub.eventTitle}" readonly disabled>
              <div class="form-text">ID: ${sub.eventId || 'General'}</div>
            </div>
            <div class="col-md-6">
              <label for="editAlertType" class="form-label fw-bold small">Tipo de Alerta</label>
              <select class="form-select" id="editAlertType">
                <option value="specific" ${sub.alertType === 'specific' ? 'selected' : ''}>Solo este evento</option>
                <option value="general" ${sub.alertType === 'general' ? 'selected' : ''}>Todos los eventos</option>
              </select>
            </div>
            <div class="col-12 mt-5 pt-3 border-top d-flex gap-3">
              <button type="submit" class="btn btn-primary px-4">Guardar Cambios</button>
              <button type="button" class="btn btn-outline-secondary" onclick="goBack(VIEW_SUBSCRIPTIONS)">Cancelar</button>
            </div>
          </form>
        </div>
      `;

      document.getElementById('editSubscriptionForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const alertType = document.getElementById('editAlertType').value;
        try {
          const updateRes = await fetch(`/apiserv/admin/subscriptions/${subId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alertType })
          });
          if (updateRes.ok) {
            showToast('Suscripción actualizada', 'success');
            goBack(VIEW_SUBSCRIPTIONS);
          } else showToast('Error al actualizar', 'error');
        } catch (err) { showToast('Error de red', 'error'); }
      });
    } catch (err) {
      viewContainer.innerHTML = `<div class="alert alert-danger">${err.message}</div>`;
    }
  }

  // --- Vista: Gestión de Usuarios (Lista Table) ---
  async function renderAccountsView() {
    await ensureAdminUser();
    viewContainer.innerHTML = `
      <div class="accounts-view container-fluid mt-2">
        <div class="view-header d-flex justify-content-between align-items-center mb-4">
          <div>
            <h2 class="view-title">Usuarios del Sistema</h2>
            <p class="text-muted small">Cuentas con acceso al panel administrativo</p>
          </div>
        </div>
        <div id="accounts-table-container"></div>
      </div>
    `;

    const columns = [
      { id: 'username', label: 'Usuario', width: '200px', align: 'left', render: (v, row) => `
        <div class="d-flex align-items-center">
            ${row.avatarUrl ? `<img src="${row.avatarUrl}" class="user-avatar-sm" alt="Avatar">` : `<div class="user-avatar-sm bg-light text-secondary d-flex justify-content-center align-items-center"><i class="bi bi-person"></i></div>`}
            <span class="fw-bold text-dark">${v}</span>
        </div>` 
      },
      { id: 'fullName', label: 'Nombre Completo', width: '200px', align: 'left', render: (v) => v || '<span class="text-muted small italic">Sin nombre</span>' },
      { id: 'email', label: 'Email', width: '220px', align: 'left', render: (v) => v || '<span class="text-muted italic">No configurado</span>' },
      { id: 'role', label: 'Rol', width: '120px', align: 'center', render: (v, row) => `
        <span class="badge ${v === 'root' ? 'bg-danger' : v === 'admin' ? 'bg-primary' : 'bg-secondary'}">
          ${v.toUpperCase()}
        </span>
        ${row.isSuperuser ? '<span class="badge bg-dark border ms-1"><i class="bi bi-star-fill me-1"></i>Super</span>' : ''}
      `},
      { id: 'createdAt', label: 'Creado', width: '120px', align: 'left', type: 'date' }
    ];

    if (currentUser && currentUser.isSuperuser) {
      columns.splice(4, 0, { id: 'environmentName', label: 'Entorno', width: '150px', align: 'left', render: (v) => `<span class="badge bg-light text-secondary border">${v || 'Global'}</span>` });
    }

    const table = await EnterpriseTable.create({
      id: 'accounts-table',
      columns: columns,
      onCreateNew: () => window.openCreateAccountModal && window.openCreateAccountModal(),
      onRowDblClick: (row) => setView(VIEW_ACCOUNT_EDIT, row.id, true),
      onBulkDelete: async (ids) => {
        if (!confirm(`¿Seguro que quieres eliminar ${ids.length} cuentas?`)) return;
        for (const id of ids) {
          await fetch(`/apiserv/admin/accounts/${id}`, { method: 'DELETE' });
        }
        renderAccountsView();
      }
    });

    table.render(document.getElementById('accounts-table-container'));

    try {
      const res = await fetch('/apiserv/admin/accounts');
      if (!res.ok) throw new Error('No autorizado');
      const accounts = await res.json();
      table.setData(accounts);
      // Guarda las prefs por defecto si es la primera vez que se carga con datos
      const raw = currentUser && currentUser.interface_Prefs;
      const existingPrefs = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
      if (!existingPrefs['accounts-table']) await table.initDefaultPrefs();
    } catch (err) {
      console.error(err);
      document.getElementById('accounts-table-container').innerHTML = `<div class="alert alert-danger">${err.message}</div>`;
    }
  }

  // --- Vista: Edición de Usuario (Full Page) ---
  async function renderAccountEditView(accountId) {
    if (!accountId && currentUser) accountId = currentUser.id;
    if (!accountId) return setView(VIEW_ACCOUNTS);

    viewContainer.innerHTML = `<div class="text-center py-5"><div class="spinner-border"></div></div>`;

    try {
      const res = await fetch(`/apiserv/admin/accounts/${accountId}`);
      if (!res.ok) throw new Error('Cuenta no encontrada');
      const acc = await res.json();

      const isSelf = String(acc.id) === String(currentUser.id);
      const isRoot = currentUser.role === 'root';

      viewContainer.innerHTML = `
        <div class="user-edit-page mt-4">
          <nav aria-label="breadcrumb" class="mb-4">
            <ol class="breadcrumb">
              ${!isSelf ? '<li class="breadcrumb-item"><a href="#" onclick="goBack(VIEW_ACCOUNTS)">Usuarios</a></li>' : ''}
              <li class="breadcrumb-item active">${isSelf ? 'Mi Perfil' : `Editar a ${acc.username}`}</li>
            </ol>
          </nav>

          <div class="d-flex align-items-center justify-content-between mb-4 border-bottom pb-3">
             <h2 class="mb-0">${isSelf ? 'Mi Perfil' : 'Perfil de Usuario'}: <span class="text-primary">${acc.username}</span></h2>
             <span class="badge ${acc.role === 'root' ? 'bg-danger' : 'bg-primary'} fs-6">${acc.role.toUpperCase()}</span>
          </div>

          <form id="editAccountForm" class="row g-3">
            <div class="col-12 mt-2 mb-3 d-flex flex-column align-items-center">
               <div id="editAvatarContainer" class="position-relative cursor-pointer" style="width: 100px; height: 100px; border-radius: 50%; border: 2px dashed #cbd5e1; display:flex; align-items:center; justify-content:center; overflow:hidden; background: #f8fafc; transition: all 0.2s;">
                  <img id="editAvatarPreview" class="w-100 h-100 object-fit-cover ${acc.avatarUrl ? '' : 'd-none'}" src="${acc.avatarUrl || ''}" alt="Avatar">
                  <div class="upload-instructions text-center ${acc.avatarUrl ? 'd-none' : ''}">
                    <i class="bi bi-camera text-secondary fs-3"></i>
                  </div>
                  <input type="file" id="editAvatarInput" class="d-none" accept="image/jpeg, image/png, image/webp, image/svg+xml">
               </div>
               <input type="hidden" id="editAvatarUrl" value="${acc.avatarUrl || ''}">
               <div class="form-text mt-2 extra-small text-muted">Click para cambiar tu foto</div>
            </div>

            <div class="col-md-6">
              <label class="form-label fw-bold small">Nombre de Usuario (Login)</label>
              <input type="text" class="form-control" value="${acc.username}" readonly disabled>
              <div class="form-text">El nombre de usuario no puede cambiarse.</div>
            </div>
            <div class="col-md-6">
              <label for="editFirstName" class="form-label fw-bold small">Nombre</label>
              <input type="text" class="form-control" id="editFirstName" value="${acc.firstName || ''}" placeholder="Tu nombre">
            </div>
            <div class="col-md-6">
              <label for="editLastName" class="form-label fw-bold small">Apellidos</label>
              <input type="text" class="form-control" id="editLastName" value="${acc.lastName || ''}" placeholder="Tus apellidos">
            </div>

            <div class="col-md-12">
              <label for="editEmail" class="form-label fw-bold small">Correo Electrónico</label>
              <input type="email" class="form-control" id="editEmail" value="${acc.email || ''}" placeholder="email@ejemplo.com" autocomplete="username">
            </div>

            <div class="col-md-6">
              <label for="editRole" class="form-label fw-bold small">Rol del Sistema</label>
              <select class="form-select" id="editRole" ${(acc.role === 'root' || (isSelf && !isRoot)) ? 'disabled' : ''}>
                <option value="admin" ${acc.role === 'admin' ? 'selected' : ''}>Administrador</option>
                <option value="user" ${acc.role === 'user' ? 'selected' : ''}>Usuario</option>
                <option value="colaborator" ${acc.role === 'colaborator' ? 'selected' : ''}>Colaborador</option>
              </select>
              ${isSelf && !isRoot ? '<div class="form-text extra-small text-muted">Sólo un administrador raíz puede cambiar tu rol.</div>' : ''}
            </div>
            ${currentUser && (currentUser.isSuperuser || isRoot) ? `
            <div class="col-md-6 d-flex align-items-center">
              <div class="form-check form-switch mt-3">
                <input class="form-check-input" type="checkbox" id="editSuperuser" ${acc.isSuperuser ? 'checked' : ''} ${(acc.role === 'root' || (isSelf && !isRoot)) ? 'disabled' : ''}>
                <label class="form-check-label fw-bold" for="editSuperuser">¿Superusuario (Root capabilities)?</label>
              </div>
            </div>
            ` : ''}

            <div class="col-12 mt-4">
              <div class="card bg-light border-0">
                <div class="card-body">
                  <h6 class="card-title fw-bold"><i class="bi bi-shield-lock me-2"></i>Cambiar Contraseña</h6>
                  <p class="text-muted small">Deja estos campos vacíos si no deseas cambiar la contraseña.</p>
                  <div class="row g-2">
                    <div class="col-md-6">
                      <input type="password" class="form-control" id="editPassword" placeholder="Nueva contraseña" autocomplete="new-password">
                    </div>
                    <div class="col-md-6">
                      <div class="form-check mt-1">
                        <input class="form-check-input" type="checkbox" id="sendEmailNotify">
                        <label class="form-check-label small" for="sendEmailNotify">
                          Notificar al usuario por email con su nueva contraseña
                        </label>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div class="col-12 mt-4">
              <div class="card bg-light border-0">
                <div class="card-body">
                  <h6 class="card-title fw-bold small text-muted text-uppercase mb-3">
                    <i class="bi bi-code-square me-2"></i>Preferencias de Interfaz (Metadata)
                  </h6>
                  <div class="metadata-json">${JSON.stringify(acc.interface_Prefs ? (typeof acc.interface_Prefs === 'string' ? JSON.parse(acc.interface_Prefs) : acc.interface_Prefs) : {}, null, 2)}</div>
                  <div class="form-text extra-small mt-2">Este bloque JSON contiene los ajustes técnicos de tus tablas (orden de columnas, anchos, etc). Se actualiza automáticamente.</div>
                </div>
              </div>
            </div>

            <div class="col-12 mt-4 pt-4 border-top d-flex justify-content-between align-items-center">
              <div class="d-flex gap-2">
                <button type="submit" class="btn btn-primary px-4">Guardar Cambios</button>
                <button type="button" class="btn btn-outline-secondary" onclick="goBack(${isSelf ? 'VIEW_INFOGRAPHIC' : 'VIEW_ACCOUNTS'})">${isSelf ? 'Volver' : 'Cancelar'}</button>
              </div>
              <button type="button" class="btn btn-outline-warning btn-sm rounded-pill px-3" id="btnResetPrefs">
                <i class="bi bi-arrow-counterclockwise me-2"></i>Restablecer Diseño Interfaz
              </button>
            </div>
          </form>
        </div>
      `;

      const btnReset = document.getElementById('btnResetPrefs');
      if (btnReset) {
        btnReset.onclick = async () => {
          if (!confirm('¿Seguro que quieres borrar todas tus preferencias de columnas y tablas?')) return;
          try {
            const res = await fetch(`/apiserv/admin/accounts/${acc.id}/prefs`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ interface_Prefs: null })
            });
            if (res.ok) {
              const result = await res.json();
              if (String(acc.id) === String(currentUser.id)) {
                currentUser.interface_Prefs = result.interface_Prefs;
              }
              showToast('Preferencias borradas. Los cambios se verán al recargar.', 'success');
              if (String(acc.id) === String(currentUser.id)) setTimeout(() => window.location.reload(), 1500);
            }
          } catch (e) {
            console.error('Error reset prefs', e);
          }
        };
      }

      // Logic for Avatar Upload
      const avatarContainer = document.getElementById('editAvatarContainer');
      const avatarInput = document.getElementById('editAvatarInput');
      const avatarPreview = document.getElementById('editAvatarPreview');
      const avatarUrlInput = document.getElementById('editAvatarUrl');
      const avatarInstructions = avatarContainer.querySelector('.upload-instructions');

      const handleAvatarFile = async (file) => {
        if (!file.type.startsWith('image/')) return alert('El archivo debe ser una imagen válida.');
        if (file.size > 500 * 1024) return alert('La imagen excede el tamaño máximo de 500kb.');

        const formData = new FormData();
        formData.append('avatar', file);

        try {
          avatarContainer.style.opacity = '0.5';
          const res = await fetch('/apiserv/admin/upload/avatar', {
            method: 'POST',
            body: formData
          });

          if (!res.ok) {
            const data = await res.json();
            throw new Error(data.error || 'Error al subir la imagen');
          }

          const data = await res.json();
          avatarUrlInput.value = data.url;
          avatarPreview.src = data.url;
          avatarPreview.classList.remove('d-none');
          avatarInstructions.classList.add('d-none');
        } catch (e) {
          alert('Error de subida: ' + e.message);
        } finally {
          avatarContainer.style.opacity = '1';
        }
      };

      avatarContainer.addEventListener('click', () => avatarInput.click());
      avatarInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) handleAvatarFile(e.target.files[0]);
      });

      avatarContainer.addEventListener('dragover', (e) => {
        e.preventDefault();
        avatarContainer.style.borderColor = '#6366f1';
      });
      avatarContainer.addEventListener('dragleave', () => avatarContainer.style.borderColor = '#cbd5e1');
      avatarContainer.addEventListener('drop', (e) => {
        e.preventDefault();
        avatarContainer.style.borderColor = '#cbd5e1';
        if (e.dataTransfer.files && e.dataTransfer.files[0]) handleAvatarFile(e.dataTransfer.files[0]);
      });

      document.getElementById('editAccountForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const firstName = document.getElementById('editFirstName').value;
        const lastName = document.getElementById('editLastName').value;
        const email = document.getElementById('editEmail').value;
        const password = document.getElementById('editPassword').value;
        const roleEl = document.getElementById('editRole');
        const role = roleEl ? roleEl.value : acc.role;
        const superuserEl = document.getElementById('editSuperuser');
        const isSuperuser = superuserEl ? superuserEl.checked : acc.isSuperuser;
        const sendNotify = document.getElementById('sendEmailNotify') ? document.getElementById('sendEmailNotify').checked : false;
        const avatarUrl = document.getElementById('editAvatarUrl').value;

        try {
          const payload = { firstName, lastName, email, password, role, isSuperuser, sendNotify, avatarUrl };
          const updateRes = await fetch(`/apiserv/admin/accounts/${acc.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          if (updateRes.ok) {
            showToast(isSelf ? 'Perfil actualizado correctamente' : 'Usuario actualizado correctamente', 'success');
            if (isSelf) {
              // Si es su propio perfil, recargar datos de sesión (o refrescar UI)
              await checkAdminStatus();
            }
            goBack(isSelf ? VIEW_INFOGRAPHIC : VIEW_ACCOUNTS);
          } else {
            const data = await updateRes.json();
            alert('Error: ' + data.error);
          }
        } catch (err) { alert('Error de red'); }
      });

    } catch (err) {
      viewContainer.innerHTML = `<div class="alert alert-danger">${err.message}</div>`;
    }
  }

  // --- Vista: Registro de Auditoría ---
  async function renderAuditView() {
    await ensureAdminUser();
    viewContainer.innerHTML = `
      <div class="audit-view container-fluid mt-2">
        <h2 class="view-title mb-4">Registro de Auditoría (Audit Log)</h2>
        <div id="audit-table-container"></div>
      </div>
    `;

    const columns = [
      { id: 'timestamp', label: 'Fecha', width: '180px', align: 'left', type: 'date' },
      { id: 'username', label: 'Usuario', width: '150px', align: 'left', type: 'badge' },
      { id: 'action', label: 'Acción', width: '100px', align: 'center', type: 'badge' },
      { id: 'targetType', label: 'Tipo', width: '120px', align: 'left' },
      { id: 'details', label: 'Detalles', width: 'auto', align: 'left' }
    ];

    if (currentUser && currentUser.isSuperuser) {
      columns.splice(2, 0, { id: 'environmentName', label: 'Entorno', width: '150px', align: 'left', type: 'badge' });
    }

    const table = await EnterpriseTable.create({
      id: 'audit-table',
      columns: columns
    });

    table.render(document.getElementById('audit-table-container'));

    try {
      const res = await fetch('/apiserv/admin/audit-logs');
      const logs = await res.json();
      table.setData(logs);
      // Guarda las prefs por defecto si es la primera vez
      const raw = currentUser && currentUser.interface_Prefs;
      const existingPrefs = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
      if (!existingPrefs['audit-table']) await table.initDefaultPrefs();
    } catch (err) {
      console.error(err);
      document.getElementById('audit-table-container').innerHTML = `<div class="alert alert-danger">${err.message}</div>`;
    }
  }

  // --- Vista: Gestión de Entornos ---
  async function renderEnvironmentsView() {
    viewContainer.innerHTML = `
      <div class="environments-view container-fluid mt-2">
        <div class="view-header d-flex justify-content-between align-items-center mb-4">
          <div>
            <h2 class="view-title">Gestión de Entornos</h2>
            <p class="text-muted small">Administra los diferentes entornos de la aplicación</p>
          </div>
          <button class="btn btn-primary btn-sm" onclick="window.openCreateEnvironmentModal()">
            <i class="bi bi-plus-circle-fill me-2"></i>Nuevo Entorno
          </button>
        </div>
        <div id="environmentsTableContainer">
            <div class="text-center py-5"><div class="spinner-border text-primary"></div></div>
        </div>
      </div>
    `;

    try {
      const res = await fetch('/apiserv/admin/environments');
      if (!res.ok) throw new Error('No autorizado');
      const environments = await res.json();
      
      const container = document.getElementById('environmentsTableContainer');

      if (environments.length === 0) {
        container.innerHTML = '<div class="alert alert-info border-0 shadow-sm mt-3"><i class="bi bi-info-circle me-2"></i>No hay entornos configurados.</div>';
        return;
      }

      container.innerHTML = ''; // Limpiar spinner

      const table = await EnterpriseTable.create({
        id: 'environmentsTable',
        columns: [
          {
            id: 'alias',
            label: 'Alias',
            width: '150px',
            sortable: true,
            renderCell: (val) => `<span class="badge bg-light text-dark border">${val}</span>`
          },
          {
            id: 'title',
            label: 'Título',
            width: '250px',
            sortable: true,
            renderCell: (val) => `<span class="fw-bold text-dark">${val || '(Sin título)'}</span>`
          },
          {
            id: 'googleDocSource',
            label: 'Google Doc Source',
            width: '250px',
            sortable: true,
            renderCell: (val) => `<div class="text-truncate" style="max-width: 200px;" title="${val || ''}">${val || '-'}</div>`
          },
          {
            id: 'createdAt',
            label: 'Fecha Creación',
            width: '150px',
            sortable: true,
            renderCell: (val) => `<span class="small text-muted">${new Date(val).toLocaleDateString()}</span>`
          },
          {
            id: 'actions',
            label: 'Acciones',
            width: '100px',
            sortable: false,
            renderCell: (_, row) => `
              <div class="text-end">
                <div class="btn-group btn-group-sm">
                  <button class="btn btn-outline-primary" onclick="setView(VIEW_ENVIRONMENT_EDIT, ${row.id}, true)" title="Editar">
                    <i class="bi bi-pencil-square"></i>
                  </button>
                  <button class="btn btn-outline-danger" onclick="window.deleteEnvironment(${row.id}, '${row.alias}')" title="Eliminar">
                    <i class="bi bi-trash"></i>
                  </button>
                </div>
              </div>
            `
          }
        ]
      });

      table.render(document.getElementById('environmentsTableContainer'));
      table.setData(environments);
      
      const raw = currentUser && currentUser.interface_Prefs;
      const existingPrefs = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
      if (!existingPrefs['environmentsTable']) await table.initDefaultPrefs();

      window.deleteEnvironment = async (id, name) => {
        if (!confirm(`¿Seguro que quieres eliminar el entorno "${name}"?`)) return;
        try {
          const mRes = await fetch(`/apiserv/admin/environments/${id}`, { method: 'DELETE' });
          if (mRes.ok) setView(VIEW_ENVIRONMENTS);
          else {
            const d = await mRes.json();
            alert('Error: ' + d.error);
          }
        } catch (e) { alert('Error de conexión'); }
      };

    } catch (err) {
      document.getElementById('environmentsTableContainer').innerHTML = `<div class="alert alert-danger mt-3">${err.message}</div>`;
    }
  }

  window.openCreateEnvironmentModal = () => {
    const modalHtml = `
      <div class="modal fade" id="createEnvironmentModal" tabindex="-1">
        <div class="modal-dialog">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title">Crear Nuevo Entorno</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <form id="createEnvironmentForm">
                <div class="mb-3">
                  <label class="form-label small fw-bold">Alias (ID de URL)</label>
                  <input type="text" class="form-control" id="envAlias" placeholder="ej: mi-proyecto" required>
                  <div class="form-text">Debe ser único y sin espacios.</div>
                </div>
                <div class="mb-3">
                  <label class="form-label small fw-bold">Título</label>
                  <input type="text" class="form-control" id="envTitle" placeholder="Calendario de Rehabilitación">
                </div>
                <div class="mb-3">
                  <label class="form-label small fw-bold">Subtítulo</label>
                  <input type="text" class="form-control" id="envSubtitle" placeholder="Préstamos y Seguimiento">
                </div>
              </form>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancelar</button>
              <button type="button" class="btn btn-primary" onclick="window.submitCreateEnvironment()">Crear Entorno</button>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    const modal = new bootstrap.Modal(document.getElementById('createEnvironmentModal'));
    modal.show();
    document.getElementById('createEnvironmentModal').addEventListener('hidden.bs.modal', e => e.target.remove());
  };

  window.submitCreateEnvironment = async () => {
    const alias = document.getElementById('envAlias').value;
    const title = document.getElementById('envTitle').value;
    const subtitle = document.getElementById('envSubtitle').value;

    if (!alias) return alert('El alias del entorno es obligatorio.');

    try {
      const res = await fetch('/apiserv/admin/environments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alias, title, subtitle, configJson: {} })
      });
      const data = await res.json();
      if (res.ok) {
        alert('Entorno creado exitosamente. Ahora puedes editar sus detalles y añadir documentos.');
        bootstrap.Modal.getInstance(document.getElementById('createEnvironmentModal')).hide();
        setView(VIEW_ENVIRONMENT_EDIT, data.id);
      } else {
        alert('Error: ' + data.error);
      }
    } catch (e) { alert('Error de conexión'); }
  };

  async function renderEnvironmentEditView(envId) {
    if (!envId) return setView(VIEW_ENVIRONMENTS);
    viewContainer.innerHTML = `<div class="text-center py-5"><div class="spinner-border text-primary"></div></div>`;

    try {
      const [envRes, docsRes] = await Promise.all([
        fetch(`/apiserv/admin/environments/${envId}`),
        fetch(`/apiserv/admin/environments/${envId}/documents`)
      ]);

      if (!envRes.ok) throw new Error('Entorno no encontrado');
      const env = await envRes.json();
      const docs = await docsRes.json();

      viewContainer.innerHTML = `
        <div class="environment-edit-page mt-4">
          <nav aria-label="breadcrumb" class="mb-4">
            <ol class="breadcrumb">
              <li class="breadcrumb-item"><a href="#" onclick="goBack(VIEW_ENVIRONMENTS)">Entornos</a></li>
              <li class="breadcrumb-item active">Configurar Entorno</li>
            </ol>
          </nav>

          <div class="d-flex align-items-center justify-content-between mb-4 border-bottom pb-3">
             <h2 class="mb-0">Configuración: <span class="text-primary">${env.title || env.alias}</span></h2>
             <span class="badge bg-light text-dark border font-monospace fs-6">${env.alias}</span>
          </div>

          <div class="row g-4">
            <!-- Columna Izquierda: Metadatos y Config -->
            <div class="col-lg-8">
              <div class="card shadow-sm border-0 mb-4">
                <div class="card-header bg-white fw-bold"><i class="bi bi-info-circle me-2"></i>Información General</div>
                <div class="card-body">
                  <form id="editEnvironmentForm" class="row g-3">
                    <div class="col-md-6">
                      <label class="form-label small fw-bold">Título del Proyecto</label>
                      <input type="text" class="form-control" id="editEnvTitle" value="${env.title || ''}">
                    </div>
                    
                    <div class="col-md-12 mt-4">
                      <label class="form-label small fw-bold">Logo del Entorno (Máx. 500kb)</label>
                      <div id="editEnvLogoContainer" class="image-upload-zone w-100">
                        <img id="editEnvLogoPreview" class="image-upload-preview ${env.logoUrl ? '' : 'd-none'}" src="${env.logoUrl || ''}" alt="Logo Preview">
                        <div class="upload-instructions ${env.logoUrl ? 'd-none' : ''}">
                          <i class="bi bi-cloud-arrow-up display-4 text-primary mb-2 d-block"></i>
                          <p class="mb-1 fw-bold">Arrastra un logo aquí o haz clic para subir</p>
                          <p class="small text-muted mb-0">Recomendado: 200x50px. Formatos: JPG, PNG, WEBP, SVG</p>
                        </div>
                        <input type="file" id="editEnvLogoInput" class="d-none" accept="image/jpeg, image/png, image/webp, image/svg+xml">
                      </div>
                      <input type="hidden" id="editEnvLogoUrl" value="${env.logoUrl || ''}">
                    </div>
                    <div class="col-md-6">
                      <label class="form-label small fw-bold">Subtítulo / Descripción Corta</label>
                      <input type="text" class="form-control" id="editEnvSubtitle" value="${env.subtitle || ''}">
                    </div>
                    <div class="col-12 mt-4">
                      <label class="form-label small fw-bold">Configuración JSON Avanzada</label>
                      <textarea class="form-control font-monospace text-xs" id="editEnvConfig" rows="10" style="font-size: 0.8rem;">${JSON.stringify(env.configJson || {}, null, 2)}</textarea>
                      <div class="form-text">Aquí se definen las fuentes (ICS/Sheets), separadores, días festivos, etc.</div>
                    </div>
                    <div class="col-12 mt-4 d-flex gap-2">
                       <button type="submit" class="btn btn-primary px-4">Guardar Configuración</button>
                    </div>
                  </form>
                </div>
              </div>
            </div>

            <!-- Columna Derecha: Documentos Origen -->
            <div class="col-lg-4">
               <div class="card shadow-sm border-0 h-100">
                  <div class="card-header bg-white d-flex justify-content-between align-items-center">
                    <span class="fw-bold"><i class="bi bi-file-earmark-medical me-2"></i>Documentos Origen</span>
                    <button class="btn btn-xs btn-outline-primary" onclick="window.showAddDocModal(${envId})">
                      <i class="bi bi-plus-lg"></i> Añadir
                    </button>
                  </div>
                  <div class="card-body p-0">
                    <div class="list-group list-group-flush" id="envDocsList">
                      ${docs.length === 0 ? '<div class="p-4 text-center text-muted small">No hay documentos configurados.</div>' : docs.map(doc => `
                        <div class="list-group-item d-flex justify-content-between align-items-start py-3">
                          <div class="ms-2 me-auto overflow-hidden">
                            <div class="d-flex align-items-center gap-2 mb-1">
                              ${doc.color ? `<span style="display:inline-block; width:10px; height:10px; border-radius:50%; background:${doc.color}; shadow-sm"></span>` : ''}
                              <div class="fw-bold small text-truncate" title="${doc.label}">${doc.label}</div>
                            </div>
                            <div class="text-muted extra-small text-truncate" title="${doc.url}">${doc.url}</div>
                            <span class="badge bg-light text-secondary border extra-small mt-1">${doc.type}</span>
                          </div>
                          <div class="btn-group btn-group-xs ms-2">
                            <button class="btn btn-link py-0 px-1 text-primary" onclick="setView(VIEW_DOCUMENT_EDIT, ${doc.id}, true)"><i class="bi bi-pencil"></i></button>
                            <button class="btn btn-link py-0 px-1 text-danger" onclick="window.deleteDoc(${envId}, ${doc.id}, '${doc.label}')"><i class="bi bi-trash"></i></button>
                          </div>
                        </div>
                      `).join('')}
                    </div>
                  </div>
               </div>
            </div>
          </div>
          
          <div class="mt-4 border-top pt-3">
            <button type="button" class="btn btn-outline-secondary" onclick="goBack(VIEW_ENVIRONMENTS)">
               <i class="bi bi-arrow-left me-2"></i>Volver al listado
            </button>
          </div>
        </div>
      `;

      // Image Upload Logic for Environment Logo
      const logoContainer = document.getElementById('editEnvLogoContainer');
      const logoInput = document.getElementById('editEnvLogoInput');
      const logoPreview = document.getElementById('editEnvLogoPreview');
      const logoUrlInput = document.getElementById('editEnvLogoUrl');
      const logoInstructions = logoContainer.querySelector('.upload-instructions');

      const handleLogoFile = async (file) => {
        if (!file.type.startsWith('image/')) return alert('El archivo debe ser una imagen válido.');
        if (file.size > 500 * 1024) return alert('La imagen excede el tamaño máximo de 500kb.');

        const formData = new FormData();
        formData.append('logo', file);

        try {
          logoContainer.style.opacity = '0.5';
          const res = await fetch('/apiserv/admin/upload/logo', {
            method: 'POST',
            body: formData
          });

          if (!res.ok) {
            const data = await res.json();
            throw new Error(data.error || 'Error al subir la imagen');
          }

          const data = await res.json();
          logoUrlInput.value = data.url;
          logoPreview.src = data.url;
          logoPreview.classList.remove('d-none');
          logoInstructions.classList.add('d-none');
        } catch (e) {
          alert(e.message);
        } finally {
          logoContainer.style.opacity = '1';
        }
      };

      logoContainer.addEventListener('click', () => logoInput.click());
      logoInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) handleLogoFile(e.target.files[0]);
      });

      logoContainer.addEventListener('dragover', (e) => {
        e.preventDefault();
        logoContainer.classList.add('dragover');
      });
      logoContainer.addEventListener('dragleave', () => logoContainer.classList.remove('dragover'));
      logoContainer.addEventListener('drop', (e) => {
        e.preventDefault();
        logoContainer.classList.remove('dragover');
        if (e.dataTransfer.files && e.dataTransfer.files[0]) handleLogoFile(e.dataTransfer.files[0]);
      });

      document.getElementById('editEnvironmentForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const title = document.getElementById('editEnvTitle').value;
        const subtitle = document.getElementById('editEnvSubtitle').value;
        const logoUrl = document.getElementById('editEnvLogoUrl').value;
        let configJson;
        try {
          configJson = JSON.parse(document.getElementById('editEnvConfig').value);
        } catch (e) {
          return alert('Error en el formato del JSON de configuración: ' + e.message);
        }

        try {
          const updateRes = await fetch(`/apiserv/admin/environments/${envId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, subtitle, configJson, logoUrl })
          });
          if (updateRes.ok) {
            showToast('Configuración actualizada correctamente', 'success');
            goBack(VIEW_ENVIRONMENTS);
          }
          else alert('Error al actualizar entorno');
        } catch (err) { alert('Error de red'); }
      });

      window.showAddDocModal = (envId) => {
        let modal = document.getElementById('addDocModal');
        if (!modal) {
          modal = document.createElement('div');
          modal.id = 'addDocModal';
          modal.className = 'modal fade';
          modal.innerHTML = `
            <div class="modal-dialog">
              <div class="modal-content">
                <div class="modal-header">
                  <h5 class="modal-title">Añadir Documento Origen</h5>
                  <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                  <form id="addDocForm">
                    <div class="mb-3">
                      <label class="form-label small fw-bold">Nombre / Etiqueta</label>
                      <input type="text" class="form-control" id="newDocLabel" required placeholder="Ej: Calendario Principal">
                    </div>
                    <div class="mb-3">
                      <label class="form-label small fw-bold">Tipo</label>
                      <select class="form-select" id="newDocType">
                        <option value="ics">Calendario (ICS)</option>
                        <option value="sheet">Hoja de Cálculo (Sheets)</option>
                        <option value="infographic">Infografía (Google Doc)</option>
                        <option value="other">Otro</option>
                      </select>
                    </div>
                    <div class="mb-3">
                      <label class="form-label small fw-bold">URL / Fuente</label>
                      <textarea class="form-control font-monospace text-xs" id="newDocUrl" rows="3" required placeholder="https://..."></textarea>
                    </div>
                    <div class="mb-3">
                      <label class="form-label small fw-bold">Color (Opcional)</label>
                      <div class="d-flex gap-2">
                         <input type="color" class="form-control form-control-color" id="newDocColor" value="#0d6efd">
                         <input type="text" class="form-control" id="newDocColorText" value="#0d6efd" placeholder="#HEX">
                      </div>
                    </div>
                  </form>
                </div>
                <div class="modal-footer">
                  <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancelar</button>
                  <button type="submit" form="addDocForm" class="btn btn-primary">Añadir Documento</button>
                </div>
              </div>
            </div>
          `;
          document.body.appendChild(modal);

          const cInput = modal.querySelector('#newDocColor');
          const cText = modal.querySelector('#newDocColorText');
          cInput.addEventListener('input', () => cText.value = cInput.value);
          cText.addEventListener('input', () => { if (/^#[0-9A-F]{6}$/i.test(cText.value)) cInput.value = cText.value; });
        }

        const form = document.getElementById('addDocForm');
        form.onsubmit = async (e) => {
          e.preventDefault();
          const label = document.getElementById('newDocLabel').value;
          const type = document.getElementById('newDocType').value;
          const url = document.getElementById('newDocUrl').value;
          const color = document.getElementById('newDocColor').value;

          try {
            const res = await fetch(`/apiserv/admin/environments/${envId}/documents`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ label, type, url, color })
            });
            if (res.ok) {
              bootstrap.Modal.getInstance(modal).hide();
              renderEnvironmentEditView(envId);
            } else alert('Error al añadir documento');
          } catch (e) { alert('Error de red'); }
        };

        new bootstrap.Modal(modal).show();
      };

      window.deleteDoc = async (envId, docId, label) => {
        if (!confirm(`¿Eliminar el documento "${label}"?`)) return;
        try {
          // Usamos el endpoint global de borrado por ID
          const res = await fetch(`/apiserv/admin/documents/${docId}`, { method: 'DELETE' });
          if (res.ok) renderEnvironmentEditView(envId);
          else alert('Error al eliminar');
        } catch (e) { alert('Error de red'); }
      };
      // --- Eventos de Formulario ---

    } catch (err) {
      viewContainer.innerHTML = `<div class="alert alert-danger">${err.message}</div>`;
    }
  }

  // Funciones globales para botones
  window.openCreateAccountModal = () => {
    const modalHtml = `
      <div class="modal fade" id="createAccountModal" tabindex="-1">
        <div class="modal-dialog">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title">Crear Nueva Cuenta Administrativa</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <form id="createAccountForm">
                <div class="mb-3">
                  <label class="form-label">Nombre de Usuario</label>
                  <input type="text" class="form-control" id="accUsername" required>
                </div>
                <div class="mb-3">
                  <label class="form-label">Contraseña</label>
                  <input type="password" class="form-control" id="accPassword" required>
                </div>
                <div class="row">
                  <div class="col-6 mb-3">
                    <label class="form-label">Nombre</label>
                    <input type="text" class="form-control" id="accFirstName">
                  </div>
                  <div class="col-6 mb-3">
                    <label class="form-label">Apellidos</label>
                    <input type="text" class="form-control" id="accLastName">
                  </div>
                </div>
                <div class="mb-3">
                  <label class="form-label">Correo Electrónico (Opcional)</label>
                  <input type="email" class="form-control" id="accEmail">
                </div>
                <div class="mb-3">
                  <label class="form-label">Rol</label>
                  <select class="form-select" id="accRole">
                    <option value="admin">Administrador</option>
                    <option value="user" selected>Usuario (Lectura)</option>
                    <option value="colaborator">Colaborador</option>
                  </select>
                </div>
                ${currentUser && currentUser.isSuperuser ? `
                <div class="mb-3 form-check form-switch">
                  <input type="checkbox" class="form-check-input" id="accSuperuser">
                  <label class="form-check-label small fw-bold" for="accSuperuser">¿Superusuario (Root)?</label>
                </div>
                ` : ''}
                <div class="mb-3 form-check">
                  <input type="checkbox" class="form-check-input" id="accNotify">
                  <label class="form-check-label small" for="accNotify">Enviar credenciales por email</label>
                </div>
              </form>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancelar</button>
              <button type="button" class="btn btn-primary" onclick="window.submitCreateAccount()">Crear Cuenta</button>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    const modal = new bootstrap.Modal(document.getElementById('createAccountModal'));
    modal.show();
    document.getElementById('createAccountModal').addEventListener('hidden.bs.modal', e => e.target.remove());
  };

  window.submitCreateAccount = async () => {
    const username = document.getElementById('accUsername').value;
    const password = document.getElementById('accPassword').value;
    const role = document.getElementById('accRole').value;
    const firstName = document.getElementById('accFirstName').value;
    const lastName = document.getElementById('accLastName').value;
    const email = document.getElementById('accEmail').value;
    const isSuperuser = document.getElementById('accSuperuser') ? document.getElementById('accSuperuser').checked : false;
    const sendNotify = document.getElementById('accNotify').checked;

    if (!username || !password) return alert('Completa todos los campos');

    try {
      const res = await fetch('/apiserv/admin/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, role, isSuperuser, email, sendNotify, firstName, lastName })
      });
      const data = await res.json();
      if (res.ok) {
        showToast('Cuenta creada exitosamente', 'success');
        bootstrap.Modal.getInstance(document.getElementById('createAccountModal')).hide();
        if (currentView === VIEW_ACCOUNTS) renderAccountsView();
      } else {
        alert('Error: ' + data.error);
      }
    } catch (e) { alert('Error de conexión'); }
  };

  window.deleteAccount = async (id, name) => {
    if (!confirm(`¿Seguro que quieres eliminar la cuenta de "${name}"?`)) return;
    try {
      const res = await fetch('/apiserv/admin/accounts/' + id, { method: 'DELETE' });
      if (res.ok) renderAccountsView();
      else {
        const d = await res.json();
        alert('Error: ' + d.error);
      }
    } catch (e) { alert('Error de conexión'); }
  };

  async function logout() {
    try {
      const res = await fetch('/apiserv/admin/logout', { method: 'POST' });
      if (res.ok) {
        currentUser = null;
        window.location.reload();
      }
    } catch (err) {
      alert('Error al cerrar sesión');
    }
  }

  async function checkAdminStatus() {
    try {
      const res = await fetch('/apiserv/admin/me', { credentials: 'include' });
      if (res.ok) {
        currentUser = await res.json();
        console.log('[Auth] currentUser cargado:', currentUser.username, 'id:', currentUser.id);
        const userProfile = document.getElementById('userProfile');
        const userName = document.getElementById('userName');
        const adminLoginBtn = document.getElementById('adminLoginBtn');
        const appSidebar = document.getElementById('appSidebar');

        if (userProfile && userName && adminLoginBtn && appSidebar) {
          userName.textContent = currentUser.fullName || currentUser.username;
          userProfile.classList.remove('d-none');
          userProfile.classList.add('d-flex');
          adminLoginBtn.classList.add('d-none');
          
          const navAvatar = document.getElementById('nav-user-avatar');
          if (navAvatar && currentUser.avatarUrl) {
            navAvatar.src = currentUser.avatarUrl;
            navAvatar.classList.remove('d-none');
          }

          // El sidebar ya es visible por defecto (#appSidebar en index.html)
          renderAdminControls();
        }
      } else {
        // No logueado o sesión expirada
        currentUser = null;
      }
    } catch (err) {
      // Error de red, etc.
      currentUser = null;
    }
  }

  // Garantiza que currentUser esté cargado (útil para vistas dinámicas como accounts)
  async function ensureAdminUser() {
    if (currentUser) return true;
    try {
      const res = await fetch('/apiserv/admin/me', { credentials: 'include' });
      if (res.ok) {
        currentUser = await res.json();
        return true;
      }
    } catch (e) { console.error('[Auth] ensureAdminUser falló', e); }
    return false;
  }

  function renderAdminControls() {
    if (!currentUser) return;
    const sidebarNav = document.getElementById('sidebarNav');
    if (!sidebarNav) return;

    // Eliminar botones dinámicos previos (pero no el de Calendario que es fijo)
    // Buscamos solo los que no son navCalendar
    sidebarNav.querySelectorAll('.nav-item').forEach(item => {
      if (item.querySelector('#navCalendar')) return;
      item.remove();
    });

    const navItems = [
      { id: 'navDashboard', label: 'Dashboard', icon: 'bi-grid-1x2-fill', view: VIEW_INFOGRAPHIC, roles: ['root', 'admin', 'colaborator'] },
      { id: 'navEnvironments', label: 'Entornos', icon: 'bi-box-seam-fill', view: VIEW_ENVIRONMENTS, roles: ['root', 'admin'], superonly: true },
      { id: 'navDocuments', label: 'Documentos', icon: 'bi-file-earmark-medical', view: VIEW_DOCUMENTS, roles: ['root', 'admin'], superonly: true },
      { id: 'navSubscriptions', label: 'Suscripciones', icon: 'bi-envelope-paper-fill', view: VIEW_SUBSCRIPTIONS, roles: ['root', 'admin', 'user'] },
      { id: 'navAccounts', label: 'Usuarios', icon: 'bi-people-fill', view: VIEW_ACCOUNTS, roles: ['root', 'admin'] },
      { id: 'navAudit', label: 'Auditoría', icon: 'bi-journal-text', view: VIEW_AUDIT, roles: ['root'] }
    ];

    navItems.forEach(item => {
      const hasRole = item.roles.includes(currentUser.role);
      const passesSuperCheck = (item.superonly ? !!currentUser.isSuperuser : true) || currentUser.role === 'root';

      if (hasRole && passesSuperCheck) {
        const li = document.createElement('li');
        li.className = 'nav-item';
        li.innerHTML = `
          <a href="#" class="nav-link ${currentView === item.view ? 'active' : ''}" id="${item.id}" data-view="${item.view}">
            <i class="bi ${item.icon}"></i>
            <span>${item.label}</span>
          </a>
        `;
        li.querySelector('a').addEventListener('click', (e) => {
          e.preventDefault();
          clearNavigationHistory();
          setView(item.view);
        });
        sidebarNav.appendChild(li);
      }
    });

    // Actualizar nombre del botón de login si existe (aunque ahora se usa el profile)
    const adminLoginBtn = document.getElementById('adminLoginBtn');
    if (adminLoginBtn) adminLoginBtn.classList.add('d-none');
  }

  async function renderDocumentsView() {
    viewContainer.innerHTML = `
      <div class="documents-page mt-4">
        <div class="d-flex align-items-center justify-content-between mb-4">
          <h2 class="mb-0"><i class="bi bi-file-earmark-medical me-3 text-primary"></i>Gestión de Documentos</h2>
        </div>
        <div class="card shadow-sm border-0">
          <div class="card-body p-0">
            <div id="documentsTableContainer">
               <div class="text-center p-5 text-muted small"><div class="spinner-border spinner-border-sm me-2"></div>Cargando documentos...</div>
            </div>
          </div>
        </div>
      </div>
    `;

    try {
      const res = await fetch('/apiserv/admin/documents');
      if (!res.ok) throw new Error('Error al cargar documentos');
      const docs = await res.json();

      const container = document.getElementById('documentsTableContainer');
      if (docs.length === 0) {
        container.innerHTML = `<div class="text-center p-5 text-muted small">No hay documentos registrados.</div>`;
        return;
      }

      container.innerHTML = ''; // clear spinner

      const table = await EnterpriseTable.create({
        id: 'documentsTable',
        columns: [
          {
            id: 'environmentAlias',
            label: 'Entorno',
            width: '180px',
            sortable: true,
            renderCell: (val, row) => `
              <div class="fw-bold">${row.environmentTitle || row.environmentAlias}</div>
              <div class="text-muted extra-small">${row.environmentAlias}</div>
            `
          },
          {
            id: 'label',
            label: 'Documento / Etiqueta',
            width: '250px',
            sortable: true,
            renderCell: (val, row) => `
              <div class="d-flex align-items-center gap-2">
                ${row.color ? `<span style="display:inline-block; width:12px; height:12px; border-radius:3px; background:${row.color};"></span>` : ''}
                <span class="fw-bold">${val}</span>
              </div>
            `
          },
          {
            id: 'type',
            label: 'Tipo',
            width: '120px',
            sortable: true,
            renderCell: (val) => `<span class="badge bg-light text-secondary border extra-small">${val}</span>`
          },
          {
            id: 'url',
            label: 'URL / Origen',
            width: '250px',
            sortable: true,
            renderCell: (val) => `<div class="small text-muted font-monospace text-truncate" style="max-width:200px;" title="${val || ''}">${val || '-'}</div>`
          },
          {
            id: 'color',
            label: 'Color',
            width: '100px',
            sortable: true,
            renderCell: (val) => val ? `<code class="small">${val}</code>` : '-'
          },
          {
            id: 'actions',
            label: 'Acciones',
            width: '100px',
            sortable: false,
            renderCell: (_, row) => `
              <div class="text-end">
                <div class="btn-group btn-group-sm">
                  <button class="btn btn-outline-primary" onclick="setView(VIEW_DOCUMENT_EDIT, ${row.id}, true)" title="Editar"><i class="bi bi-pencil-square"></i></button>
                  <button class="btn btn-outline-danger" onclick="window.deleteDocumentGlobal(${row.id}, '${row.label}')" title="Eliminar"><i class="bi bi-trash"></i></button>
                </div>
              </div>
            `
          }
        ]
      });

      table.render(document.getElementById('documentsTableContainer'));
      table.setData(docs);
      
      const rawDoc = currentUser && currentUser.interface_Prefs;
      const existingDocPrefs = rawDoc ? (typeof rawDoc === 'string' ? JSON.parse(rawDoc) : rawDoc) : {};
      if (!existingDocPrefs['documentsTable']) await table.initDefaultPrefs();

      window.deleteDocumentGlobal = async (id, label) => {
        if (!confirm(`¿Eliminar el documento "${label}"?`)) return;
        try {
          const mRes = await fetch(`/apiserv/admin/documents/${id}`, { method: 'DELETE' });
          if (mRes.ok) setView(VIEW_DOCUMENTS);
          else alert('Error al eliminar');
        } catch (e) { alert('Error de red'); }
      };

    } catch (err) {
      document.getElementById('documentsTableContainer').innerHTML = `<div class="alert alert-danger m-3">${err.message}</div>`;
    }
  }

  async function renderDocumentEditView(docId) {
    if (!docId) return setView(VIEW_DOCUMENTS);
    viewContainer.innerHTML = `<div class="text-center py-5"><div class="spinner-border"></div></div>`;

    try {
      const res = await fetch(`/apiserv/admin/documents/${docId}`);
      if (!res.ok) throw new Error('Documento no encontrado');
      const doc = await res.json();

      const metadata = doc.metadata ? (typeof doc.metadata === 'string' ? JSON.parse(doc.metadata) : doc.metadata) : {};

      viewContainer.innerHTML = `
        <div class="document-edit-page mt-4">
          <nav aria-label="breadcrumb" class="mb-4">
            <ol class="breadcrumb">
              <li class="breadcrumb-item"><a href="#" onclick="goBack(VIEW_DOCUMENTS)">Documentos</a></li>
              <li class="breadcrumb-item active">Editar Documento</li>
            </ol>
          </nav>
          <div class="d-flex align-items-center justify-content-between mb-4 border-bottom pb-3">
             <h2 class="mb-0">Editar: <span class="text-primary">${doc.label}</span></h2>
          </div>
          <form id="editDocumentForm" class="row g-4">
            <div class="col-md-6">
               <div class="card shadow-sm border-0">
                  <div class="card-header bg-white fw-bold small uppercase">Datos Básicos</div>
                  <div class="card-body">
                    <div class="mb-3">
                      <label class="form-label small fw-bold">Nombre / Etiqueta</label>
                      <input type="text" class="form-control" id="editDocLabel" value="${doc.label}" required>
                    </div>
                    <div class="mb-3">
                      <label class="form-label small fw-bold">Tipo de Documento</label>
                      <select class="form-select" id="editDocType">
                        <option value="infographic" ${doc.type === 'infographic' ? 'selected' : ''}>Infografía (Google Doc)</option>
                        <option value="ics" ${doc.type === 'ics' ? 'selected' : ''}>Calendario (ICS)</option>
                        <option value="sheet" ${doc.type === 'sheet' ? 'selected' : ''}>Hoja de Cálculo (Google Sheets)</option>
                        <option value="other" ${doc.type === 'other' ? 'selected' : ''}>Otro</option>
                      </select>
                    </div>
                    <div class="mb-3">
                      <label class="form-label small fw-bold">Color Identificativo</label>
                      <div class="d-flex gap-2">
                        <input type="color" class="form-control form-control-color" id="editDocColor" value="${doc.color || '#0d6efd'}">
                        <input type="text" class="form-control" id="editDocColorText" value="${doc.color || '#0d6efd'}" placeholder="#HEX">
                      </div>
                    </div>
                  </div>
               </div>
            </div>
            <div class="col-md-6">
               <div class="card shadow-sm border-0">
                  <div class="card-header bg-white fw-bold small uppercase">Localización y Origen</div>
                  <div class="card-body h-100">
                    <div class="mb-3">
                      <label class="form-label small fw-bold">URL completa del origen</label>
                      <textarea class="form-control font-monospace text-xs" id="editDocUrl" rows="4" style="font-size: 0.8rem;" required>${doc.url}</textarea>
                      <div class="form-text small">Debe ser una URL pública o accesible por el servidor.</div>
                    </div>
                    <div class="mb-3">
                      <label class="form-label small fw-bold">Metadata Adicional (JSON)</label>
                      <textarea class="form-control font-monospace text-xs" id="editDocMetadata" rows="4" style="font-size: 0.8rem;">${JSON.stringify(metadata, null, 2)}</textarea>
                    </div>
                  </div>
               </div>
            </div>
            <div class="col-12 mt-4 pt-3 border-top d-flex gap-3">
              <button type="submit" class="btn btn-primary px-4">Guardar Cambios</button>
              <button type="button" class="btn btn-outline-secondary" onclick="goBack(VIEW_DOCUMENTS)">Cancelar</button>
            </div>
          </form>
        </div>
      `;

      // Sync color inputs
      const colorInput = document.getElementById('editDocColor');
      const colorText = document.getElementById('editDocColorText');
      colorInput.addEventListener('input', () => colorText.value = colorInput.value);
      colorText.addEventListener('input', () => { if (/^#[0-9A-F]{6}$/i.test(colorText.value)) colorInput.value = colorText.value; });

      document.getElementById('editDocumentForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const label = document.getElementById('editDocLabel').value;
        const type = document.getElementById('editDocType').value;
        const url = document.getElementById('editDocUrl').value;
        const color = document.getElementById('editDocColor').value;
        let metadata = {};
        try {
          metadata = JSON.parse(document.getElementById('editDocMetadata').value);
        } catch (e) { return alert('Error en el formato JSON de metadata'); }

        try {
          const updateRes = await fetch(`/apiserv/admin/documents/${docId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ label, type, url, color, metadata })
          });
          if (updateRes.ok) {
            alert('Documento actualizado');
            goBack(VIEW_DOCUMENTS);
          } else alert('Error al actualizar');
        } catch (err) { alert('Error de red'); }
      });
    } catch (err) {
      viewContainer.innerHTML = `<div class="alert alert-danger">${err.message}</div>`;
    }
  }

  function initEvents() {
    const sidebarToggle = document.getElementById("sidebarToggle");
    const appSidebar = document.getElementById("appSidebar");
    if (sidebarToggle && appSidebar) {
      sidebarToggle.addEventListener("click", () => {
        appSidebar.classList.toggle("show");
      });
    }

    const navCalendar = document.getElementById("navCalendar");
    if (navCalendar) {
      navCalendar.addEventListener("click", (e) => {
        e.preventDefault();
        clearNavigationHistory();
        setView(VIEW_CALENDAR);
      });
    }

    const logoutBtn = document.getElementById("logoutBtn");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", (e) => {
        e.preventDefault();
        logout();
      });
    }

    const viewButtonsRef = Array.from(document.querySelectorAll(".view-button"));
    viewButtonsRef.forEach((btn) => {
      btn.addEventListener("click", () => {
        const view = btn.dataset.view;
        setView(view);
      });
    });

    const viewTabsRef = Array.from(document.querySelectorAll(".view-tab"));
    viewTabsRef.forEach((btn) => {
      btn.addEventListener("click", () => {
        const view = btn.dataset.view;
        setView(view);
      });
    });

    const searchInputRef = document.getElementById("searchInput");
    if (searchInputRef) {
      searchInputRef.addEventListener("input", () => {
        applyFilters();
      });
    }

    const forceSyncBtnRef = document.getElementById("forceSyncBtn");
    if (forceSyncBtnRef) {
      forceSyncBtnRef.addEventListener("click", () => {
        setStatus("Sincronizando…", "info");
        fetchEvents();
      });
    }

    const goTodayBtn = document.getElementById("goTodayBtn");
    if (goTodayBtn) {
      goTodayBtn.addEventListener("click", () => {
        scrollGanttToToday();
        setStatus("Scroll a hoy activado", "success");
      });
    }
  }

  async function init() {
    try {
      const configResponse = await fetch('/apiserv/config' + window.location.search);
      if (!configResponse.ok) throw new Error('Error cargando configuración');
      const config = await configResponse.json();

      window.GOOGLE_API_KEY = config.googleApiKey || '';
      window.CALENDAR_ID = config.calendarId || '';
      window.ICS_URL = config.icsUrl || '/calendar.ics';
      window.GANTT_GROUP_SEPARATORS = config.ganttGroupSeparators || [" - ", " — ", " | ", ":"];
      window.MADRID_HOLIDAYS = config.madridHolidays || [];
      window.SOURCES = config.sources || [];

      // Actualizar Header dinámico
      const headerTitle = document.querySelector('.app-header .app-title');
      const headerSubtitle = document.querySelector('.app-header .app-subtitle');
      if (headerTitle && config.title) headerTitle.textContent = config.title;
      if (headerSubtitle && config.subtitle) headerSubtitle.textContent = config.subtitle;
      if (config.title) document.title = `Calendario - ${config.title}`;

      window.SOURCES.forEach(s => activeSources.add(s.id));
      renderSourceFilters();
      ensureConfig();
    } catch (err) {
      setStatus(err.message, "error");
      return;
    }

    initEvents();
    await checkAdminStatus(); // CRITICAL: debe completarse antes de continuar

    // Cargar preferencias de fuentes si el usuario está logueado
    if (currentUser && currentUser.interface_Prefs) {
      try {
        const prefs = typeof currentUser.interface_Prefs === 'string' 
          ? JSON.parse(currentUser.interface_Prefs) 
          : currentUser.interface_Prefs;
        
        if (prefs && Array.isArray(prefs.calendar_active_sources)) {
          console.log("[Calendar] Aplicando fuentes guardadas:", prefs.calendar_active_sources);
          activeSources.clear();
          prefs.calendar_active_sources.forEach(id => {
            // Solo añadir si la fuente aún existe en window.SOURCES
            if (window.SOURCES.some(s => s.id === id)) {
              activeSources.add(id);
            }
          });
          renderSourceFilters();
        }
      } catch (e) {
        console.error("[Calendar] Error aplicando preferencias de fuentes:", e);
      }
    }

    setView(getInitialView());
    fetchEvents();
  }

  function openSubscribeModal(event, hasEventId, isDashboard = false) {
    const isAuth = !!currentUser;
    const modalHtml = `
        <div class="modal fade" id="subscribeModal" tabindex="-1">
            <div class="modal-dialog">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">${isDashboard ? 'Suscripción al Dashboard' : 'Suscribirse a notificaciones'}</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body">
                        <div class="subscription-target p-3 bg-light rounded mb-3 border">
                           <div class="small text-muted mb-1">Recibir avisos de:</div>
                           <div class="fw-bold text-dark">${isDashboard ? 'Cambios en la documentación' : (event ? event.title : 'Todos los eventos')}</div>
                        </div>

                        ${isAuth ? `
                           <div class="alert alert-info py-2 small mb-3">
                              <i class="bi bi-info-circle me-2"></i>
                              Identificado como <strong>${currentUser.username}</strong> (${currentUser.email}).
                           </div>
                           <p class="small text-muted">Las notificaciones se enviarán a tu dirección de correo electrónico de usuario.</p>
                        ` : ''}

                        <form id="subscribeForm" class="${isAuth ? 'd-none' : ''}">
                            <div class="mb-3">
                                <label for="email" class="form-label">Email <span class="text-danger">*</span></label>
                                <input type="email" class="form-control" id="email" ${isAuth ? '' : 'required'}>
                            </div>
                            <div class="mb-3">
                                <label for="name" class="form-label">Nombre</label>
                                <input type="text" class="form-control" id="name">
                            </div>
                            <div class="mb-3">
                                <label for="phone" class="form-label">Teléfono</label>
                                <input type="tel" class="form-control" id="phone">
                            </div>
                            <div class="mb-3">
                                <div class="form-check">
                                    <input class="form-check-input" type="checkbox" id="acceptPrivacy" ${isAuth ? 'checked' : 'required'}>
                                    <label class="form-check-label" for="acceptPrivacy">
                                        Acepto la <a href="/privacy.html" target="_blank">política de privacidad</a> <span class="text-danger">*</span>
                                    </label>
                                </div>
                            </div>
                        </form>

                        <div class="mb-3">
                            <label class="form-label small fw-bold">Tipo de notificación:</label>
                            ${isDashboard ? `
                            <div class="form-check">
                                <input class="form-check-input" type="radio" name="alertType" id="alertDashboard" value="dashboard" checked>
                                <label class="form-check-label" for="alertDashboard">Cambios en el Dashboard</label>
                            </div>
                            ` : `
                            <div class="form-check">
                                <input class="form-check-input" type="radio" name="alertType" id="alertSpecific" value="specific" ${hasEventId ? 'checked' : 'disabled'}>
                                <label class="form-check-label" for="alertSpecific">Solo este evento</label>
                            </div>
                            <div class="form-check">
                                <input class="form-check-input" type="radio" name="alertType" id="alertGeneral" value="general" ${!hasEventId ? 'checked' : ''}>
                                <label class="form-check-label" for="alertGeneral">Todos los eventos</label>
                            </div>
                            `}
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancelar</button>
                        <button type="button" class="btn btn-primary" id="submitSubscribe">
                           ${isAuth ? '<i class="bi bi-check-circle me-2"></i>Confirmar Suscripción' : 'Suscribirse'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    const modalElement = document.getElementById("subscribeModal");
    const modal = new bootstrap.Modal(modalElement);

    modalElement.addEventListener("shown.bs.modal", () => {
      const emailInput = document.getElementById("email");
      if (emailInput && !isAuth) emailInput.focus();
    });
    modalElement.addEventListener("hidden.bs.modal", () => { modalElement.remove(); });
    modal.show();

    document.getElementById('submitSubscribe').addEventListener('click', async () => {
      const form = document.getElementById('subscribeForm');
      if (!isAuth && !form.checkValidity()) { form.reportValidity(); return; }

      const email = isAuth ? currentUser.email : document.getElementById('email').value;
      const name = isAuth ? currentUser.username : document.getElementById('name').value;
      const phone = isAuth ? '' : document.getElementById('phone').value;
      const acceptPrivacy = isAuth ? true : document.getElementById('acceptPrivacy').checked;
      const alertType = document.querySelector('input[name="alertType"]:checked').value;

      try {
        const urlParams = new URLSearchParams(window.location.search);
        const currentAlias = urlParams.get('config') || urlParams.get('alias') || 'default';

        const response = await fetch('/apiserv/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email, name, phone,
            eventId: hasEventId ? event.id : null,
            eventTitle: isDashboard ? 'Dashboard' : (event ? event.title : 'Todos los eventos'),
            alertType, acceptPrivacy,
            returnUrl: window.location.href,
            config: currentAlias
          })
        });
        const data = await response.json();
        if (response.ok) {
          if (data.authenticated) {
            alert('¡Suscripción confirmada!');
          } else {
            alert(data.requiresConfirmation ? 'Se ha enviado un email de confirmación.' : '¡Suscripción exitosa!');
          }
          modal.hide();
        } else alert(`Error: ${data.error}`);
      } catch (error) { alert('Error al suscribirse.'); }
    });
  }

  function initAdminLogin() {
    const adminLoginForm = document.getElementById("adminLoginForm");
    const adminLoginError = document.getElementById("adminLoginError");
    if (adminLoginForm) {
      adminLoginForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        adminLoginError.classList.add("d-none");
        const usernameInput = document.getElementById("adminUsername").value;
        const passwordInput = document.getElementById("adminPassword").value;
        const submitBtn = document.getElementById("adminSubmitBtn");
        submitBtn.disabled = true;
        submitBtn.textContent = 'Verificando...';
        const urlParams = new URLSearchParams(window.location.search);
        const currentAlias = urlParams.get('config') || urlParams.get('alias');

        try {
          const res = await fetch('/apiserv/admin/login', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              username: usernameInput,
              password: passwordInput,
              config: currentAlias
            })
          });
          const data = await res.json();
          if (res.ok && data.success) {
            currentUser = data.user;
            const modalEl = document.getElementById('adminLoginModal');
            const modal = bootstrap.Modal.getInstance(modalEl);
            if (modal) modal.hide();
            await checkAdminStatus();
            setView(VIEW_INFOGRAPHIC);
          } else {
            adminLoginError.textContent = data.error || 'Credenciales inválidas';
            adminLoginError.classList.remove("d-none");
          }
        } catch (err) {
          adminLoginError.textContent = 'Error de conexión.';
          adminLoginError.classList.remove("d-none");
        } finally {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Iniciar sesión';
        }
      });
    }
    if (new URLSearchParams(window.location.search).get('login') === 'true') {
      const modal = new bootstrap.Modal(document.getElementById('adminLoginModal'));
      modal.show();
      const newUrl = window.location.protocol + "//" + window.location.host + window.location.pathname;
      window.history.replaceState({ path: newUrl }, '', newUrl);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    init();
    initAdminLogin();
  });
})();
