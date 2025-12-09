/**
 * HTTP Dashboard Server
 * Provides web interface and API for monitoring cycle arbitrage
 */

import express, { Express, Request, Response } from 'express';
import { ethers } from 'ethers';
import { MetricsCollector } from './metrics.js';

export class DashboardServer {
  private app: Express;
  private metrics: MetricsCollector;
  private port: number;
  private server?: any;

  constructor(metrics: MetricsCollector, port: number = 8080) {
    this.metrics = metrics;
    this.port = port;
    this.app = express();
    this.setupRoutes();
  }

  private setupRoutes(): void {
    // Health check
    this.app.get('/api/health', (_req: Request, res: Response) => {
      const metrics = this.metrics.getMetrics();
      const summary = this.metrics.getSummary();
      res.json({
        status: 'ok',
        uptime: summary.uptime,
        cycles: metrics.cycles.size,
        timestamp: Date.now(),
      });
    });

    // Metrics endpoint
    this.app.get('/api/metrics', (_req: Request, res: Response) => {
      const summary = this.metrics.getSummary();
      res.json({
        summary,
        cycles: this.metrics.getAllCycleMetrics().map((cycle) => ({
          ...cycle,
          totalProfit: cycle.totalProfit.toString(),
          bestAmountIn: cycle.bestAmountIn ? cycle.bestAmountIn.toString() : null,
          bestAmountInFormatted: cycle.bestAmountIn
            ? ethers.formatEther(cycle.bestAmountIn)
            : null,
          bestAmountInArbBps: cycle.bestAmountInArbBps ?? null,
          bestArbitrage: cycle.bestArbitrage === -Infinity ? null : cycle.bestArbitrage,
          worstArbitrage: cycle.worstArbitrage === Infinity ? null : cycle.worstArbitrage,
        })),
      });
    });

    // Cycle-specific metrics
    this.app.get('/api/cycles/:cycleId', (req: Request, res: Response) => {
      const cycle = this.metrics.getCycleMetrics(req.params.cycleId);
      if (!cycle) {
        res.status(404).json({ error: 'Cycle not found' });
        return;
      }
      res.json({
        ...cycle,
        totalProfit: cycle.totalProfit.toString(),
        bestAmountIn: cycle.bestAmountIn ? cycle.bestAmountIn.toString() : null,
        bestAmountInFormatted: cycle.bestAmountIn
          ? ethers.formatEther(cycle.bestAmountIn)
          : null,
        bestAmountInArbBps: cycle.bestAmountInArbBps ?? null,
        bestArbitrage: cycle.bestArbitrage === -Infinity ? null : cycle.bestArbitrage,
        worstArbitrage: cycle.worstArbitrage === Infinity ? null : cycle.worstArbitrage,
      });
    });

    // Cycle statistics from database (persisted data)
    this.app.get('/api/cycles/:cycleId/statistics', async (req: Request, res: Response) => {
      try {
        const statistics = await this.metrics.getCycleStatisticsFromDB(req.params.cycleId);
        if (!statistics) {
          res.status(404).json({ error: 'Cycle statistics not found' });
          return;
        }
        res.json(statistics);
      } catch (err: any) {
        console.error('Error loading cycle statistics:', err);
        res.status(500).json({ error: err.message });
      }
    });

    // All cycle statistics from database
    this.app.get('/api/statistics', async (_req: Request, res: Response) => {
      try {
        const statistics = await this.metrics.getAllCycleStatisticsFromDB();
        res.json({
          cycles: statistics,
          count: statistics.length,
        });
      } catch (err: any) {
        console.error('Error loading all cycle statistics:', err);
        res.status(500).json({ error: err.message });
      }
    });

    // Cycle events from database
    this.app.get('/api/cycles/:cycleId/events', async (req: Request, res: Response) => {
      try {
        const cycleId = req.params.cycleId;
        const eventType = req.query.eventType as 'opportunity' | 'execution' | undefined;
        const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;
        
        // Parse time range
        const hours = parseInt(req.query.hours as string) || 0;
        const minutes = parseInt(req.query.minutes as string) || 0;
        const days = parseInt(req.query.days as string) || 0;
        
        let startTime: number | undefined;
        let endTime: number | undefined;
        
        if (days > 0 || hours > 0 || minutes > 0) {
          endTime = Date.now();
          startTime = endTime - (
            (days * 24 * 60 * 60 * 1000) +
            (hours * 60 * 60 * 1000) +
            (minutes * 60 * 1000)
          );
        }
        
        const events = await this.metrics.getCycleEventsFromDB(
          cycleId,
          eventType,
          startTime,
          endTime,
          limit
        );
        
        res.json({
          cycleId,
          events,
          count: events.length,
          eventType: eventType || 'all',
          startTime,
          endTime,
        });
      } catch (err: any) {
        console.error('Error loading cycle events:', err);
        res.status(500).json({ error: err.message });
      }
    });

    // Historical data endpoint
    this.app.get('/api/history', async (req: Request, res: Response) => {
      const cycleId = req.query.cycleId as string;
      const hours = parseInt(req.query.hours as string) || 0;
      const minutes = parseInt(req.query.minutes as string) || 0;
      const days = parseInt(req.query.days as string) || 0;
      
      if (!cycleId) {
        res.status(400).json({ error: 'cycleId is required' });
        return;
      }
      
      try {
        // Calculate time range
        const endTime = Date.now();
        const startTime = endTime - (
          (days * 24 * 60 * 60 * 1000) +
          (hours * 60 * 60 * 1000) +
          (minutes * 60 * 1000)
        );
        
        const data = await this.metrics.getHistoricalData(cycleId, startTime, endTime);
        
        res.json({
          cycleId,
          data,
          count: data.length,
          startTime,
          endTime,
        });
      } catch (err: any) {
        console.error('Error loading historical data:', err);
        res.status(500).json({ error: err.message });
      }
    });

    // Simple HTML dashboard
    this.app.get('/', (_req: Request, res: Response) => {
      res.send(this.getDashboardHTML());
    });
  }

  start(): void {
    this.server = this.app.listen(this.port, '0.0.0.0', () => {
      console.log(`📊 Dashboard running on http://0.0.0.0:${this.port}`);
      console.log(`📊 Access from local: http://<server-ip>:${this.port}`);
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
    }
  }

  private getDashboardHTML(): string {
    return `
<!DOCTYPE html>
<html>
  <head>
    <title>Cycle Arbitrage Dashboard</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
        background: #1a1a1a;
        color: #e0e0e0;
        padding: 20px;
      }
      .container {
        max-width: 1400px;
        margin: 0 auto;
      }
      h1 {
        color: #4CAF50;
        margin-bottom: 20px;
      }
      .summary {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: 15px;
        margin-bottom: 30px;
      }
      .card {
        background: #2a2a2a;
        padding: 20px;
        border-radius: 8px;
        border: 1px solid #3a3a3a;
      }
      .card h3 {
        color: #888;
        font-size: 12px;
        text-transform: uppercase;
        margin-bottom: 10px;
      }
      .card .value {
        font-size: 24px;
        font-weight: bold;
        color: #4CAF50;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        background: #2a2a2a;
        border-radius: 8px;
        overflow: hidden;
      }
      th {
        background: #3a3a3a;
        padding: 12px;
        text-align: left;
        color: #4CAF50;
        font-weight: 600;
      }
      th.sortable {
        cursor: pointer;
        user-select: none;
        position: relative;
        padding-right: 25px;
      }
      th.sortable:hover {
        background: #4a4a4a;
      }
      th.sortable::after {
        content: ' ↕';
        position: absolute;
        right: 8px;
        opacity: 0.5;
        font-size: 12px;
      }
      th.sortable.asc::after {
        content: ' ↑';
        opacity: 1;
        color: #4CAF50;
      }
      th.sortable.desc::after {
        content: ' ↓';
        opacity: 1;
        color: #4CAF50;
      }
      td {
        padding: 10px 12px;
        border-top: 1px solid #3a3a3a;
      }
      tr:hover {
        background: #333;
      }
      .badge {
        display: inline-block;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: bold;
      }
      .badge-success {
        background: #4CAF50;
        color: white;
      }
      .badge-info {
        background: #2196F3;
        color: white;
      }
      .refresh-info {
        color: #888;
        font-size: 12px;
        margin-bottom: 20px;
      }
      .value {
        transition: opacity 0.3s ease-in-out;
      }
      .value.updating {
        opacity: 0.5;
      }
      tr {
        transition: background-color 0.2s ease;
      }
      td {
        transition: background-color 0.3s ease;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>🔄 Cycle Arbitrage Dashboard</h1>
      <div class="refresh-info">Auto-refresh every 1 second | Last update: <span id="lastUpdate">-</span></div>
      
      <div class="summary" id="summary">
        <div class="card">
          <h3>Uptime</h3>
          <div class="value" id="uptime">-</div>
        </div>
        <div class="card">
          <h3>Total Scans</h3>
          <div class="value" id="totalScans">-</div>
        </div>
        <div class="card">
          <h3>Opportunities</h3>
          <div class="value" id="opportunities">-</div>
        </div>
        <div class="card">
          <h3>Executions</h3>
          <div class="value" id="executions">-</div>
        </div>
        <div class="card">
          <h3>Total Profit</h3>
          <div class="value" id="totalProfit">-</div>
        </div>
        <div class="card">
          <h3>Scans/sec</h3>
          <div class="value" id="scansPerSec">-</div>
        </div>
      </div>

      <h2 style="margin-bottom: 15px; color: #4CAF50;">Cycle Metrics (Memory)</h2>
      <div id="cycles">Loading...</div>

      <h2 style="margin-bottom: 15px; color: #4CAF50; margin-top: 30px;">Cycle Statistics (Persisted)</h2>
      <p style="color: #888; font-size: 12px; margin-bottom: 10px;">Statistics from database - persists across restarts</p>
      <div id="statistics">Loading...</div>

      <h2 style="margin-bottom: 15px; color: #4CAF50; margin-top: 30px;">Arbitrage BPS History</h2>
      <div class="chart-controls" style="margin-bottom: 15px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
        <select id="chartCycleSelect" style="padding: 8px 12px; background: #2d3561; color: #e0e0e0; border: 1px solid #3d4561; border-radius: 5px; font-size: 14px; cursor: pointer;">
          <option value="">Select Cycle</option>
        </select>
        <select id="chartTimeRange" style="padding: 8px 12px; background: #2d3561; color: #e0e0e0; border: 1px solid #3d4561; border-radius: 5px; font-size: 14px; cursor: pointer;">
          <option value="1">Last 1 minute</option>
          <option value="15">Last 15 minutes</option>
          <option value="60" selected>Last 1 hour</option>
          <option value="240">Last 4 hours</option>
          <option value="1440">Last 24 hours</option>
          <option value="10080">Last 7 days</option>
        </select>
        <button onclick="loadChart()" style="padding: 8px 16px; background: #667eea; color: white; border: none; border-radius: 5px; cursor: pointer; font-size: 14px;">Load Chart</button>
        <label style="color: #9ca3af; font-size: 14px;">
          <input type="checkbox" id="chartAutoRefresh" onchange="toggleChartAutoRefresh()" style="margin-right: 5px;">
          Auto-refresh
        </label>
      </div>
      <div class="chart-container" style="background: #1a1f3a; border-radius: 10px; padding: 20px; margin-bottom: 20px;">
        <canvas id="arbChart" style="max-height: 400px;"></canvas>
      </div>
      
      <div id="chartDetails" style="background: #2a2a2a; border-radius: 8px; padding: 15px; margin-bottom: 20px; display: none;">
        <h3 style="color: #4CAF50; margin-bottom: 10px; font-size: 16px;">📊 Latest Scan Details</h3>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px;">
          <div>
            <div style="color: #888; font-size: 12px; margin-bottom: 5px;">Profit</div>
            <div style="color: #4CAF50; font-size: 18px; font-weight: bold;" id="detailProfit">-</div>
          </div>
          <div>
            <div style="color: #888; font-size: 12px; margin-bottom: 5px;">Min Profit</div>
            <div style="color: #ffa500; font-size: 18px; font-weight: bold;" id="detailMinProfit">-</div>
          </div>
          <div>
            <div style="color: #888; font-size: 12px; margin-bottom: 5px;">Amount In</div>
            <div style="color: #60a5fa; font-size: 18px; font-weight: bold;" id="detailAmountIn">-</div>
          </div>
          <div>
            <div style="color: #888; font-size: 12px; margin-bottom: 5px;">Arbitrage BPS</div>
            <div style="color: #e0e0e0; font-size: 18px; font-weight: bold;" id="detailArbBps">-</div>
          </div>
        </div>
      </div>
    </div>

    <script>
      function formatNumber(num) {
        if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
        if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
        if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
        return num.toString();
      }

      function formatBigInt(str) {
        const num = BigInt(str);
        if (num >= BigInt(1e18)) {
          return (Number(num) / 1e18).toFixed(4) + ' tokens';
        }
        return num.toString();
      }

      function formatHours(hours) {
        if (hours >= 24) {
          const days = Math.floor(hours / 24);
          const hrs = (hours % 24).toFixed(0);
          return days + 'd ' + hrs + 'h';
        }
        return hours + 'h';
      }

      // Smooth update helper function
      function smoothUpdate(id, value) {
        const el = document.getElementById(id);
        if (!el) return;
        const currentValue = el.textContent;
        const newValue = String(value);
        
        if (currentValue === newValue) return; // No change
        
        el.classList.add('updating');
        requestAnimationFrame(() => {
          el.textContent = newValue;
          el.classList.remove('updating');
        });
      }

      // Smooth update cell helper
      function smoothUpdateCell(cell, value) {
        if (!cell) return;
        const currentValue = cell.textContent;
        const newValue = String(value);
        
        if (currentValue === newValue) return; // No change
        
        cell.textContent = newValue;
      }

      // Sort state
      let sortColumn = null;
      let sortDirection = 'desc'; // 'asc' or 'desc'

      // Sort cycles array
      function sortCycles(cycles, column, direction) {
        const sorted = [...cycles];
        sorted.sort((a, b) => {
          let aVal, bVal;

          switch(column) {
            case 'bestArb':
              aVal = a.bestArbitrage !== null && a.bestArbitrage !== undefined
                ? a.bestArbitrage
                : (a.bestAmountInArbBps !== null && a.bestAmountInArbBps !== undefined
                    ? a.bestAmountInArbBps
                    : -Infinity);
              bVal = b.bestArbitrage !== null && b.bestArbitrage !== undefined
                ? b.bestArbitrage
                : (b.bestAmountInArbBps !== null && b.bestAmountInArbBps !== undefined
                    ? b.bestAmountInArbBps
                    : -Infinity);
              break;
            case 'avgArb':
              aVal = a.avgArbitrage || 0;
              bVal = b.avgArbitrage || 0;
              break;
            case 'totalProfit':
              aVal = BigInt(a.totalProfit || '0');
              bVal = BigInt(b.totalProfit || '0');
              break;
            case 'opportunities':
              aVal = a.opportunities || 0;
              bVal = b.opportunities || 0;
              break;
            default:
              return 0;
          }

          if (aVal < bVal) return direction === 'asc' ? -1 : 1;
          if (aVal > bVal) return direction === 'asc' ? 1 : -1;
          return 0;
        });
        return sorted;
      }

      // Handle header click for sorting
      function handleSort(column) {
        if (sortColumn === column) {
          // Toggle direction if same column
          sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
          // New column, default to desc
          sortColumn = column;
          sortDirection = 'desc';
        }

        // Update header classes
        const headers = document.querySelectorAll('th.sortable');
        headers.forEach(th => {
          th.classList.remove('asc', 'desc');
          if (th.dataset.sort === column) {
            th.classList.add(sortDirection);
          }
        });

        // Re-sort and update table
        fetch('/api/metrics')
          .then(r => r.json())
          .then(data => {
            if (data.cycles && data.cycles.length > 0) {
              const sorted = sortCycles(data.cycles, sortColumn, sortDirection);
              updateTableIncremental(sorted);
            }
          });
      }

      // Build table HTML (for first time)
      function buildTableHTML(cycles) {
        let html = '<table><thead><tr>';
        html += '<th>Cycle ID</th>';
        html += '<th>Scans</th>';
        html += '<th class="sortable" data-sort="opportunities">Opportunities</th>';
        html += '<th>Executions</th>';
        html += '<th class="sortable" data-sort="bestArb">Best Arb (bps)</th>';
        html += '<th>Best AmountIn</th>';
        html += '<th class="sortable" data-sort="avgArb">Avg Arb (bps)</th>';
        html += '<th class="sortable" data-sort="totalProfit">Total Profit</th>';
        html += '<th>Last Opportunity</th>';
        html += '</tr></thead><tbody>';

        cycles.forEach(cycle => {
          html += buildRowHTML(cycle);
        });

        html += '</tbody></table>';
        return html;
      }

      // Setup sort event listeners
      function setupSortListeners() {
        const sortableHeaders = document.querySelectorAll('th.sortable');
        sortableHeaders.forEach(header => {
          header.addEventListener('click', function() {
            const column = this.dataset.sort;
            if (column) {
              handleSort(column);
            }
          });
        });
      }

      // Build row HTML
      function buildRowHTML(cycle) {
        // Fix: Check bestAmountInFormatted more explicitly
        const bestAmountInDisplay = (cycle.bestAmountInFormatted != null && 
                                     cycle.bestAmountInFormatted !== '' && 
                                     cycle.bestAmountInFormatted !== '0.0' &&
                                     cycle.bestAmountInFormatted !== '0')
          ? cycle.bestAmountInFormatted
          : '-';
        
        // Debug: Log when building row
        console.log('[DEBUG buildRowHTML] Cycle:', cycle.cycleId, {
          bestAmountInFormatted: cycle.bestAmountInFormatted,
          bestAmountInDisplay: bestAmountInDisplay,
          type: typeof cycle.bestAmountInFormatted
        });
        
        // Best Arb display: use bestArbitrage if available, otherwise use bestAmountInArbBps
        const bestArbDisplay = cycle.bestArbitrage !== null && cycle.bestArbitrage !== undefined
          ? cycle.bestArbitrage.toFixed(2)
          : (cycle.bestAmountInArbBps !== null && cycle.bestAmountInArbBps !== undefined
              ? cycle.bestAmountInArbBps.toFixed(2)
              : '-');
        
        return '<tr data-cycle-id="' + escapeHtml(cycle.cycleId) + '">' +
          '<td><code>' + escapeHtml(cycle.cycleId) + '</code></td>' +
          '<td>' + formatNumber(cycle.scans) + '</td>' +
          '<td><span class="badge badge-info">' + cycle.opportunities + '</span></td>' +
          '<td><span class="badge badge-success">' + cycle.executions + '</span></td>' +
          '<td>' + bestArbDisplay + '</td>' +
          '<td>' + bestAmountInDisplay + '</td>' +
          '<td>' + cycle.avgArbitrage.toFixed(2) + '</td>' +
          '<td>' + formatBigInt(cycle.totalProfit) + '</td>' +
          '<td>' + (cycle.lastOpportunity ? new Date(cycle.lastOpportunity).toLocaleTimeString() : '-') + '</td>' +
          '</tr>';
      }

      // Escape HTML to prevent XSS
      function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
      }

      // Update table incrementally
      function updateTableIncremental(cycles) {
        const container = document.getElementById('cycles');
        let tbody = container.querySelector('tbody');
        
        if (!tbody) {
          // First time: create table
          if (cycles && cycles.length > 0) {
            container.innerHTML = buildTableHTML(cycles);
            // Setup sort listeners
            setupSortListeners();
            // Apply sort indicator to headers
            if (sortColumn) {
              const header = container.querySelector('th[data-sort="' + sortColumn + '"]');
              if (header) {
                header.classList.add(sortDirection);
              }
            }
          } else {
            container.innerHTML = '<p>No cycles data available</p>';
          }
          return;
        }
        
        // Update existing rows or add new ones
        cycles.forEach((cycle, index) => {
          let row = tbody.children[index];
          if (!row) {
            // Create new row
            row = document.createElement('tr');
            row.setAttribute('data-cycle-id', cycle.cycleId);
            tbody.appendChild(row);
            // Set innerHTML without <tr> tags
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = buildRowHTML(cycle);
            const tempRow = tempDiv.querySelector('tr');
            if (tempRow) {
              Array.from(tempRow.children).forEach(cell => {
                row.appendChild(cell.cloneNode(true));
              });
            }
          } else {
            // Update existing row
            updateRow(row, cycle);
          }
        });
        
        // Remove extra rows
        while (tbody.children.length > cycles.length) {
          tbody.removeChild(tbody.lastChild);
        }
      }

      // Update a single row
      function updateRow(row, cycle) {
        const cells = Array.from(row.children);
        if (cells.length === 0) {
          // Initialize row cells
          const tempDiv = document.createElement('div');
          tempDiv.innerHTML = buildRowHTML(cycle);
          const tempRow = tempDiv.querySelector('tr');
          if (tempRow) {
            Array.from(tempRow.children).forEach(cell => {
              row.appendChild(cell.cloneNode(true));
            });
          }
          return;
        }
        
        // Update only changed cells
        // Fix: Check bestAmountInFormatted more explicitly
        const bestAmountInDisplay = (cycle.bestAmountInFormatted != null && 
                                     cycle.bestAmountInFormatted !== '' && 
                                     cycle.bestAmountInFormatted !== '0.0' &&
                                     cycle.bestAmountInFormatted !== '0')
          ? cycle.bestAmountInFormatted
          : '-';
        
        // Debug: Log bestAmountIn for this cycle
        console.log('[DEBUG updateRow] Cycle:', cycle.cycleId, {
          bestAmountInFormatted: cycle.bestAmountInFormatted,
          bestAmountInDisplay: bestAmountInDisplay,
          cellsCount: cells.length
        });
        
        // Best Arb display: use bestArbitrage if available, otherwise use bestAmountInArbBps
        const bestArbDisplay = cycle.bestArbitrage !== null && cycle.bestArbitrage !== undefined
          ? cycle.bestArbitrage.toFixed(2)
          : (cycle.bestAmountInArbBps !== null && cycle.bestAmountInArbBps !== undefined
              ? cycle.bestAmountInArbBps.toFixed(2)
              : '-');
        
        // Map cell indices to values (skip cell 0 = cycleId)
        // cell[0] = Cycle ID (skip)
        // cell[1] = Scans -> values[0]
        // cell[2] = Opportunities -> values[1]
        // cell[3] = Executions -> values[2]
        // cell[4] = Best Arb -> values[3]
        // cell[5] = Best AmountIn -> values[4]
        // cell[6] = Avg Arb -> values[5]
        // cell[7] = Total Profit -> values[6]
        // cell[8] = Last Opportunity -> values[7]
        const values = [
          formatNumber(cycle.scans), // cell[1]
          cycle.opportunities, // cell[2]
          cycle.executions, // cell[3]
          bestArbDisplay, // cell[4] - Best Arb (use bestArbitrage or bestAmountInArbBps)
          bestAmountInDisplay, // cell[5] - Best AmountIn
          cycle.avgArbitrage.toFixed(2), // cell[6]
          formatBigInt(cycle.totalProfit), // cell[7]
          cycle.lastOpportunity ? new Date(cycle.lastOpportunity).toLocaleTimeString() : '-' // cell[8]
        ];
        
        // Skip first cell (cycle ID), update rest
        for (let i = 1; i < cells.length && i - 1 < values.length; i++) {
          const cell = cells[i];
          const value = values[i - 1]; // Map cell index to value index
          
          // Debug bestAmountIn cell specifically (cell index 5)
          if (i === 5) {
            console.log('[DEBUG] Updating bestAmountIn cell:', {
              cellIndex: i,
              valueIndex: i - 1,
              currentText: cell ? cell.textContent.trim() : 'no cell',
              newValue: value,
              bestAmountInFormatted: cycle.bestAmountInFormatted,
              bestAmountInDisplay: bestAmountInDisplay
            });
          }
          
          // Handle badge cells differently
          if (cell && cell.querySelector('.badge')) {
            const badge = cell.querySelector('.badge');
            if (badge && badge.textContent !== String(value)) {
              smoothUpdateCell(badge, value);
            }
          } else if (cell) {
            smoothUpdateCell(cell, value);
          }
        }
        
      }

      function updateDashboard() {
        fetch('/api/metrics')
          .then(r => r.json())
          .then(data => {
            // Update summary with smooth transitions
            smoothUpdate('uptime', formatHours(data.summary.uptime.hours));
            smoothUpdate('totalScans', formatNumber(data.summary.totalScans));
            smoothUpdate('opportunities', formatNumber(data.summary.totalOpportunities));
            smoothUpdate('executions', formatNumber(data.summary.totalExecutions));
            smoothUpdate('totalProfit', formatBigInt(data.summary.totalProfit));
            smoothUpdate('scansPerSec', data.summary.scansPerSecond);
            smoothUpdate('lastUpdate', new Date(data.summary.lastUpdate).toLocaleTimeString());

            // Update cycles table incrementally
            if (data.cycles && data.cycles.length > 0) {
              // Apply sorting if sort is active
              let cyclesToDisplay = data.cycles;
              if (sortColumn) {
                cyclesToDisplay = sortCycles(data.cycles, sortColumn, sortDirection);
              }

              // Debug: Log bestAmountInFormatted values
              cyclesToDisplay.forEach(function(cycle) {
                console.log('[DEBUG] Cycle ' + cycle.cycleId + ':', {
                  bestAmountInFormatted: cycle.bestAmountInFormatted,
                  bestAmountInFormattedType: typeof cycle.bestAmountInFormatted,
                  bestAmountIn: cycle.bestAmountIn,
                  bestAmountInArbBps: cycle.bestAmountInArbBps,
                  hasValue: cycle.bestAmountInFormatted != null && cycle.bestAmountInFormatted !== ''
                });
              });
              updateTableIncremental(cyclesToDisplay);
              
              // Update cycle select for chart
              updateChartCycleSelect(data.cycles);
            } else {
              const container = document.getElementById('cycles');
              if (container.querySelector('tbody')) {
                container.innerHTML = '<p>No cycles data available</p>';
              }
            }
          })
          .catch(err => {
            console.error('Error loading metrics:', err);
            const container = document.getElementById('cycles');
            if (!container.querySelector('p[style*="color: red"]')) {
              container.innerHTML = '<p style="color: red;">Error loading metrics: ' + err + '</p>';
            }
          });
      }

      // Statistics functions
      function formatTimestamp(timestamp) {
        if (!timestamp) return '-';
        const date = new Date(timestamp);
        return date.toLocaleString();
      }

      function buildStatisticsTableHTML(statistics) {
        if (!statistics || statistics.length === 0) {
          return '<p style="color: #888;">No statistics available yet. Statistics will appear after opportunities or executions occur.</p>';
        }

        let html = '<table><thead><tr>';
        html += '<th>Cycle ID</th>';
        html += '<th>Total Opportunities</th>';
        html += '<th>Total Executions</th>';
        html += '<th>First Opportunity</th>';
        html += '<th>Last Opportunity</th>';
        html += '<th>First Execution</th>';
        html += '<th>Last Execution</th>';
        html += '<th>Actions</th>';
        html += '</tr></thead><tbody>';

        statistics.forEach(function(stat) {
          html += '<tr data-cycle-id="' + escapeHtml(stat.cycleId) + '">';
          html += '<td><code>' + escapeHtml(stat.cycleId) + '</code></td>';
          html += '<td><span class="badge badge-info">' + stat.totalOpportunities + '</span></td>';
          html += '<td><span class="badge badge-success">' + stat.totalExecutions + '</span></td>';
          html += '<td>' + formatTimestamp(stat.firstOpportunityTimestamp) + '</td>';
          html += '<td>' + formatTimestamp(stat.lastOpportunityTimestamp) + '</td>';
          html += '<td>' + formatTimestamp(stat.firstExecutionTimestamp) + '</td>';
          html += '<td>' + formatTimestamp(stat.lastExecutionTimestamp) + '</td>';
          html += '<td>';
          html += '<button class="view-events-btn" data-cycle-id="' + escapeHtml(stat.cycleId) + '" style="padding: 4px 8px; background: #667eea; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 11px; margin-right: 5px;">View Events</button>';
          html += '</td>';
          html += '</tr>';
        });

        html += '</tbody></table>';
        return html;
      }

      function setupStatisticsEventListeners() {
        // Remove old listeners by cloning
        const container = document.getElementById('statistics');
        if (!container) return;
        
        const buttons = container.querySelectorAll('.view-events-btn');
        buttons.forEach(function(btn) {
          // Remove old listener if exists
          const newBtn = btn.cloneNode(true);
          btn.parentNode.replaceChild(newBtn, btn);
          
          // Add new listener
          newBtn.addEventListener('click', function() {
            const cycleId = this.getAttribute('data-cycle-id');
            if (cycleId) {
              viewCycleEvents(cycleId);
            }
          });
        });
      }

      function updateStatistics() {
        fetch('/api/statistics')
          .then(r => r.json())
          .then(data => {
            const container = document.getElementById('statistics');
            if (data.cycles && data.cycles.length > 0) {
              container.innerHTML = buildStatisticsTableHTML(data.cycles);
              // Setup event listeners after HTML is inserted
              setupStatisticsEventListeners();
            } else {
              container.innerHTML = '<p style="color: #888;">No statistics available yet. Statistics will appear after opportunities or executions occur.</p>';
            }
          })
          .catch(err => {
            console.error('Error loading statistics:', err);
            const container = document.getElementById('statistics');
            container.innerHTML = '<p style="color: red;">Error loading statistics: ' + err + '</p>';
          });
      }

      function viewCycleEvents(cycleId) {
        // Create modal or show events in a new section
        const modal = document.createElement('div');
        modal.id = 'eventsModal';
        modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); z-index: 1000; display: flex; align-items: center; justify-content: center;';
        
        const modalContent = document.createElement('div');
        modalContent.style.cssText = 'background: #2a2a2a; padding: 20px; border-radius: 8px; max-width: 90%; max-height: 90%; overflow: auto; position: relative;';
        
        const closeBtn = document.createElement('button');
        closeBtn.textContent = 'Close';
        closeBtn.style.cssText = 'position: absolute; top: 10px; right: 10px; background: #ff4444; color: white; border: none; border-radius: 4px; padding: 5px 10px; cursor: pointer;';
        closeBtn.addEventListener('click', function() {
          modal.remove();
        });
        
        const title = document.createElement('h3');
        title.style.cssText = 'color: #4CAF50; margin-bottom: 15px;';
        title.textContent = 'Events for ' + escapeHtml(cycleId);
        
        const content = document.createElement('div');
        content.id = 'eventsContent';
        content.textContent = 'Loading...';
        
        modalContent.appendChild(closeBtn);
        modalContent.appendChild(title);
        modalContent.appendChild(content);
        modal.appendChild(modalContent);
        document.body.appendChild(modal);

        // Load events
        fetch('/api/cycles/' + encodeURIComponent(cycleId) + '/events?limit=100')
          .then(r => r.json())
          .then(data => {
            if (data.events && data.events.length > 0) {
              let html = '<table style="width: 100%;"><thead><tr>';
              html += '<th>Type</th>';
              html += '<th>Timestamp</th>';
              html += '<th>Arbitrage BPS</th>';
              html += '<th>Profit</th>';
              html += '<th>Amount In</th>';
              html += '<th>TX Hash</th>';
              html += '</tr></thead><tbody>';
              
              data.events.forEach(function(event) {
                html += '<tr>';
                html += '<td><span class="badge ' + (event.eventType === 'opportunity' ? 'badge-info' : 'badge-success') + '">' + escapeHtml(event.eventType) + '</span></td>';
                html += '<td>' + formatTimestamp(event.timestamp) + '</td>';
                html += '<td>' + (event.arbitrageBps !== null ? event.arbitrageBps.toFixed(2) : '-') + '</td>';
                html += '<td>' + (event.profit ? formatBigInt(event.profit) : '-') + '</td>';
                html += '<td>' + (event.amountIn ? formatBigInt(event.amountIn) : '-') + '</td>';
                if (event.txHash) {
                  const txHashEscaped = escapeHtml(event.txHash);
                  html += '<td><a href="https://bscscan.com/tx/' + txHashEscaped + '" target="_blank" style="color: #60a5fa;">' + escapeHtml(event.txHash.substring(0, 10)) + '...</a></td>';
                } else {
                  html += '<td>-</td>';
                }
                html += '</tr>';
              });
              
              html += '</tbody></table>';
              content.innerHTML = html;
            } else {
              content.innerHTML = '<p style="color: #888;">No events found for this cycle.</p>';
            }
          })
          .catch(err => {
            content.innerHTML = '<p style="color: red;">Error loading events: ' + escapeHtml(String(err)) + '</p>';
          });
      }

      // Initial load
      updateDashboard();
      updateStatistics();
      // Auto-refresh every 1 second (smooth updates, no page reload)
      setInterval(updateDashboard, 1000);
      // Refresh statistics every 5 seconds (less frequent since it's persisted data)
      setInterval(updateStatistics, 5000);

      // Chart functionality
      let arbChart = null;
      let chartAutoRefreshInterval = null;

      function updateChartCycleSelect(cycles) {
        const select = document.getElementById('chartCycleSelect');
        const currentValue = select.value;
        
        // Clear existing options except first one
        select.innerHTML = '<option value="">Select Cycle</option>';
        
        // Add cycle options
        cycles.forEach(function(cycle) {
          const option = document.createElement('option');
          option.value = cycle.cycleId;
          option.textContent = cycle.cycleId;
          if (cycle.cycleId === currentValue) {
            option.selected = true;
          }
          select.appendChild(option);
        });
      }

      function loadChart() {
        const cycleId = document.getElementById('chartCycleSelect').value;
        const minutes = parseInt(document.getElementById('chartTimeRange').value);
        
        if (!cycleId) {
          alert('Please select a cycle');
          return;
        }
        
        fetch('/api/history?cycleId=' + encodeURIComponent(cycleId) + '&minutes=' + minutes)
          .then(function(r) { return r.json(); })
          .then(function(data) {
            updateChart(data);
            updateChartDetails(data);
          })
          .catch(function(err) {
            console.error('Error loading chart data:', err);
            alert('Error loading chart data: ' + err);
          });
      }

      function updateChartDetails(data) {
        const detailsDiv = document.getElementById('chartDetails');
        if (!detailsDiv) return;
        
        // Get the latest data point with profit, minProfit, amountIn
        let latestPoint = null;
        for (let i = data.data.length - 1; i >= 0; i--) {
          const point = data.data[i];
          if (point.profit || point.minProfit || point.amountIn) {
            latestPoint = point;
            break;
          }
        }
        
        if (latestPoint) {
          detailsDiv.style.display = 'block';
          
          const profitEl = document.getElementById('detailProfit');
          const minProfitEl = document.getElementById('detailMinProfit');
          const amountInEl = document.getElementById('detailAmountIn');
          const arbBpsEl = document.getElementById('detailArbBps');
          
          if (profitEl) {
            profitEl.textContent = latestPoint.profit 
              ? formatWeiToEther(latestPoint.profit) + ' ETH'
              : '-';
          }
          if (minProfitEl) {
            minProfitEl.textContent = latestPoint.minProfit 
              ? formatWeiToEther(latestPoint.minProfit) + ' ETH'
              : '-';
          }
          if (amountInEl) {
            amountInEl.textContent = latestPoint.amountIn 
              ? formatWeiToEther(latestPoint.amountIn) + ' ETH'
              : '-';
          }
          if (arbBpsEl) {
            arbBpsEl.textContent = latestPoint.arbitrageBps !== null 
              ? latestPoint.arbitrageBps.toFixed(2) + ' bps'
              : '-';
          }
        } else {
          detailsDiv.style.display = 'none';
        }
      }

      function formatWeiToEther(weiStr) {
        if (!weiStr) return null;
        try {
          const wei = BigInt(weiStr);
          const ether = Number(wei) / 1e18;
          return ether.toFixed(6);
        } catch (e) {
          return weiStr;
        }
      }

      function updateChart(data) {
        const ctx = document.getElementById('arbChart');
        if (!ctx) return;
        
        const canvas = ctx.getContext('2d');
        if (!canvas) return;
        
        // Prepare data
        const labels = data.data.map(function(point) {
          return new Date(point.timestamp).toLocaleTimeString();
        });
        
        const arbBpsData = data.data.map(function(point) {
          return point.arbitrageBps !== null ? point.arbitrageBps : null;
        });
        
        const bestAmountInArbBpsData = data.data.map(function(point) {
          return point.bestAmountInArbBps !== null ? point.bestAmountInArbBps : null;
        });
        
        // Store full data points for tooltip
        const fullDataPoints = data.data;
        
        // Destroy existing chart
        if (arbChart) {
          arbChart.destroy();
        }
        
        // Create new chart
        arbChart = new Chart(canvas, {
          type: 'line',
          data: {
            labels: labels,
            datasets: [
              {
                label: 'Arbitrage BPS (from opportunities)',
                data: arbBpsData,
                borderColor: '#4ade80',
                backgroundColor: 'rgba(74, 222, 128, 0.1)',
                tension: 0.1,
                spanGaps: true,
                pointRadius: 2,
                pointHoverRadius: 4,
              },
              {
                label: 'Best AmountIn Arb BPS (from optimization)',
                data: bestAmountInArbBpsData,
                borderColor: '#60a5fa',
                backgroundColor: 'rgba(96, 165, 250, 0.1)',
                tension: 0.1,
                spanGaps: true,
                pointRadius: 2,
                pointHoverRadius: 4,
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
              title: {
                display: true,
                text: 'Arbitrage BPS History - ' + data.cycleId + ' (' + data.count + ' points)',
                color: '#e0e0e0',
                font: { size: 16 }
              },
              legend: {
                labels: { color: '#e0e0e0' },
                display: true
              },
              tooltip: {
                mode: 'index',
                intersect: false,
                callbacks: {
                  afterBody: function(context) {
                    const index = context[0].dataIndex;
                    const point = fullDataPoints[index];
                    if (!point) return '';
                    
                    const lines = [];
                    if (point.profit !== null && point.profit !== undefined) {
                      const profitEth = formatWeiToEther(point.profit);
                      lines.push('Profit: ' + profitEth + ' ETH');
                    }
                    if (point.minProfit !== null && point.minProfit !== undefined) {
                      const minProfitEth = formatWeiToEther(point.minProfit);
                      lines.push('Min Profit: ' + minProfitEth + ' ETH');
                    }
                    if (point.amountIn !== null && point.amountIn !== undefined) {
                      const amountInEth = formatWeiToEther(point.amountIn);
                      lines.push('Amount In: ' + amountInEth + ' ETH');
                    }
                    return lines.length > 0 ? lines : '';
                  }
                }
              }
            },
            scales: {
              x: {
                ticks: { color: '#9ca3af', maxTicksLimit: 20 },
                grid: { color: '#2d3561' }
              },
              y: {
                ticks: { color: '#9ca3af' },
                grid: { color: '#2d3561' },
                title: {
                  display: true,
                  text: 'Arbitrage BPS',
                  color: '#e0e0e0'
                }
              }
            },
            interaction: {
              mode: 'nearest',
              axis: 'x',
              intersect: false
            }
          }
        });
      }

      function toggleChartAutoRefresh() {
        const checkbox = document.getElementById('chartAutoRefresh');
        if (checkbox.checked) {
          // Start auto-refresh every 5 seconds
          if (chartAutoRefreshInterval) {
            clearInterval(chartAutoRefreshInterval);
          }
          chartAutoRefreshInterval = setInterval(function() {
            const cycleId = document.getElementById('chartCycleSelect').value;
            if (cycleId && arbChart) {
              loadChart();
            }
          }, 5000);
        } else {
          // Stop auto-refresh
          if (chartAutoRefreshInterval) {
            clearInterval(chartAutoRefreshInterval);
            chartAutoRefreshInterval = null;
          }
        }
      }
    </script>
  </body>
</html>
    `;
  }
}

