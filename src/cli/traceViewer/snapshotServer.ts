/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import type { TraceModel, trace } from './traceModel';
import { TraceServer } from './traceServer';

export class SnapshotServer {
  private _resourcesDir: string | undefined;
  private _server: TraceServer;
  private _resourceById: Map<string, trace.NetworkResourceTraceEvent>;

  constructor(server: TraceServer, traceModel: TraceModel, resourcesDir: string | undefined) {
    this._resourcesDir = resourcesDir;
    this._server = server;

    this._resourceById = new Map();
    for (const contextEntry of traceModel.contexts) {
      for (const pageEntry of contextEntry.pages) {
        for (const action of pageEntry.actions)
          action.resources.forEach(r => this._resourceById.set(r.resourceId, r));
        pageEntry.resources.forEach(r => this._resourceById.set(r.resourceId, r));
      }
    }

    server.routePath('/snapshot/', this._serveSnapshotRoot.bind(this), true);
    server.routePath('/snapshot/service-worker.js', this._serveServiceWorker.bind(this));
    server.routePrefix('/resources/', this._serveResource.bind(this));
  }

  snapshotRootUrl() {
    return this._server.urlPrefix() + '/snapshot/';
  }

  snapshotUrl(pageId: string, snapshotId?: string, timestamp?: number) {
    // Prefer snapshotId over timestamp.
    if (snapshotId)
      return this._server.urlPrefix() + `/snapshot/pageId/${pageId}/snapshotId/${snapshotId}/main`;
    if (timestamp)
      return this._server.urlPrefix() + `/snapshot/pageId/${pageId}/timestamp/${timestamp}/main`;
    return 'data:text/html,Snapshot is not available';
  }

  private _serveSnapshotRoot(request: http.IncomingMessage, response: http.ServerResponse): boolean {
    response.statusCode = 200;
    response.setHeader('Cache-Control', 'public, max-age=31536000');
    response.setHeader('Content-Type', 'text/html');
    response.end(`
      <style>
        html, body {
          margin: 0;
          padding: 0;
        }
        iframe {
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          border: none;
        }
      </style>
      <body>
        <script>
          navigator.serviceWorker.register('./service-worker.js');

          let showPromise = Promise.resolve();
          if (!navigator.serviceWorker.controller)
            showPromise = new Promise(resolve => navigator.serviceWorker.oncontrollerchange = resolve);

          let current = document.createElement('iframe');
          document.body.appendChild(current);
          let next = document.createElement('iframe');
          document.body.appendChild(next);
          next.style.visibility = 'hidden';

          let nextUrl;
          window.showSnapshot = url => {
            if (!nextUrl) {
              showPromise = showPromise.then(async () => {
                const url = nextUrl;
                nextUrl = undefined;
                const loaded = new Promise(f => next.onload = f);
                next.src = url;
                await loaded;
                let temp = current;
                current = next;
                next = temp;
                current.style.visibility = 'visible';
                next.style.visibility = 'hidden';
              });
            }
            nextUrl = url;
            return showPromise;
          };
        </script>
      </body>
    `);
    return true;
  }

  private _serveServiceWorker(request: http.IncomingMessage, response: http.ServerResponse): boolean {
    function serviceWorkerMain(self: any /* ServiceWorkerGlobalScope */) {
      let traceModel: TraceModel;

      function preprocessModel() {
        for (const contextEntry of traceModel.contexts) {
          contextEntry.resourcesByUrl = new Map();
          const appendResource = (event: trace.NetworkResourceTraceEvent) => {
            let responseEvents = contextEntry.resourcesByUrl.get(event.url);
            if (!responseEvents) {
              responseEvents = [];
              contextEntry.resourcesByUrl.set(event.url, responseEvents);
            }
            responseEvents.push(event);
          };
          for (const pageEntry of contextEntry.pages) {
            for (const action of pageEntry.actions)
              action.resources.forEach(appendResource);
            pageEntry.resources.forEach(appendResource);
          }
        }
      }

      self.addEventListener('install', function(event: any) {
        event.waitUntil(fetch('/tracemodel').then(async response => {
          traceModel = await response.json();
          preprocessModel();
        }));
      });

      self.addEventListener('activate', function(event: any) {
        event.waitUntil(self.clients.claim());
      });

      function parseUrl(urlString: string): { pageId: string, frameId: string, timestamp?: number, snapshotId?: string } {
        const url = new URL(urlString);
        const parts = url.pathname.split('/');
        if (!parts[0])
          parts.shift();
        if (!parts[parts.length - 1])
          parts.pop();
        // - /snapshot/pageId/<pageId>/snapshotId/<snapshotId>/<frameId>
        // - /snapshot/pageId/<pageId>/timestamp/<timestamp>/<frameId>
        if (parts.length !== 6 || parts[0] !== 'snapshot' || parts[1] !== 'pageId' || (parts[3] !== 'snapshotId' && parts[3] !== 'timestamp'))
          throw new Error(`Unexpected url "${urlString}"`);
        return {
          pageId: parts[2],
          frameId: parts[5] === 'main' ? '' : parts[5],
          snapshotId: (parts[3] === 'snapshotId' ? parts[4] : undefined),
          timestamp: (parts[3] === 'timestamp' ? +parts[4] : undefined),
        };
      }

      function respond404(): Response {
        return new Response(null, { status: 404 });
      }

      function respondNotAvailable(): Response {
        return new Response('<body>Snapshot is not available</body>', { status: 200, headers: { 'Content-Type': 'text/html' } });
      }

      function removeHash(url: string) {
        try {
          const u = new URL(url);
          u.hash = '';
          return u.toString();
        } catch (e) {
          return url;
        }
      }

      async function doFetch(event: any /* FetchEvent */): Promise<Response> {
        try {
          const pathname = new URL(event.request.url).pathname;
          if (pathname === '/snapshot/service-worker.js' || pathname === '/snapshot/')
            return fetch(event.request);
        } catch (e) {
        }

        const request = event.request;
        let parsed;
        if (request.mode === 'navigate') {
          parsed = parseUrl(request.url);
        } else {
          const client = (await self.clients.get(event.clientId))!;
          parsed = parseUrl(client.url);
        }

        let contextEntry;
        let pageEntry;
        for (const c of traceModel.contexts) {
          for (const p of c.pages) {
            if (p.created.pageId === parsed.pageId) {
              contextEntry = c;
              pageEntry = p;
            }
          }
        }
        if (!contextEntry || !pageEntry)
          return request.mode === 'navigate' ? respondNotAvailable() : respond404();

        const lastSnapshotEvent = new Map<string, trace.FrameSnapshotTraceEvent>();
        for (const [frameId, snapshots] of Object.entries(pageEntry.snapshotsByFrameId)) {
          for (const snapshot of snapshots) {
            const current = lastSnapshotEvent.get(frameId);
            // Prefer snapshot with exact id.
            const exactMatch = parsed.snapshotId && snapshot.snapshotId === parsed.snapshotId;
            const currentExactMatch = current && parsed.snapshotId && current.snapshotId === parsed.snapshotId;
            // If not available, prefer the latest snapshot before the timestamp.
            const timestampMatch = parsed.timestamp && snapshot.timestamp <= parsed.timestamp;
            if (exactMatch || (timestampMatch && !currentExactMatch))
              lastSnapshotEvent.set(frameId, snapshot);
          }
        }

        const snapshotEvent = lastSnapshotEvent.get(parsed.frameId);
        if (!snapshotEvent)
          return request.mode === 'navigate' ? respondNotAvailable() : respond404();

        if (request.mode === 'navigate')
          return new Response(snapshotEvent.snapshot.html, { status: 200, headers: { 'Content-Type': 'text/html' } });

        let resource: trace.NetworkResourceTraceEvent | null = null;
        const resourcesWithUrl = contextEntry.resourcesByUrl.get(removeHash(request.url)) || [];
        for (const resourceEvent of resourcesWithUrl) {
          if (resource && resourceEvent.frameId !== parsed.frameId)
            continue;
          resource = resourceEvent;
          if (resourceEvent.frameId === parsed.frameId)
            break;
        }
        if (!resource)
          return respond404();
        const resourceOverride = snapshotEvent.snapshot.resourceOverrides.find(o => o.url === request.url);
        const overrideSha1 = resourceOverride ? resourceOverride.sha1 : undefined;

        const response = overrideSha1 ?
          await fetch(`/resources/${resource.resourceId}/override/${overrideSha1}`) :
          await fetch(`/resources/${resource.resourceId}`);
        // We make a copy of the response, instead of just forwarding,
        // so that response url is not inherited as "/resources/...", but instead
        // as the original request url.
        // Response url turns into resource base uri that is used to resolve
        // relative links, e.g. url(/foo/bar) in style sheets.
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }

      self.addEventListener('fetch', function(event: any) {
        event.respondWith(doFetch(event));
      });
    }

    response.statusCode = 200;
    response.setHeader('Cache-Control', 'public, max-age=31536000');
    response.setHeader('Content-Type', 'application/javascript');
    response.end(`(${serviceWorkerMain.toString()})(self)`);
    return true;
  }

  private _serveResource(request: http.IncomingMessage, response: http.ServerResponse): boolean {
    if (!this._resourcesDir)
      return false;

    // - /resources/<resourceId>
    // - /resources/<resourceId>/override/<overrideSha1>
    const parts = request.url!.split('/');
    if (!parts[0])
      parts.shift();
    if (!parts[parts.length - 1])
      parts.pop();
    if (parts[0] !== 'resources')
      return false;

    let resourceId;
    let overrideSha1;
    if (parts.length === 2) {
      resourceId = parts[1];
    } else if (parts.length === 4 && parts[2] === 'override') {
      resourceId = parts[1];
      overrideSha1 = parts[3];
    } else {
      return false;
    }

    const resource = this._resourceById.get(resourceId);
    if (!resource)
      return false;
    const sha1 = overrideSha1 || resource.responseSha1;
    try {
      const content = fs.readFileSync(path.join(this._resourcesDir, sha1));
      response.statusCode = 200;
      let contentType = resource.contentType;
      const isTextEncoding = /^text\/|^application\/(javascript|json)/.test(contentType);
      if (isTextEncoding && !contentType.includes('charset'))
        contentType = `${contentType}; charset=utf-8`;
      response.setHeader('Content-Type', contentType);
      for (const { name, value } of resource.responseHeaders)
        response.setHeader(name, value);

      response.removeHeader('Content-Encoding');
      response.removeHeader('Access-Control-Allow-Origin');
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.removeHeader('Content-Length');
      response.setHeader('Content-Length', content.byteLength);
      response.end(content);
      return true;
    } catch (e) {
      return false;
    }
  }
}