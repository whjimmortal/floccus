// Nextcloud ADAPTER
// All owncloud specifc stuff goes in here
import Adapter from '../interfaces/Adapter'
import HtmlSerializer from '../serializers/Html'
import Logger from '../Logger'
import { Bookmark, Folder, TItem } from '../Tree'
import { Base64 } from 'js-base64'
import AsyncLock from 'async-lock'
import browser from '../browser-api'
import * as Parallel from 'async-parallel'
import url from 'url'
import PQueue from 'p-queue'
import flatten from 'lodash/flatten'
import { BulkImportResource, LoadFolderChildrenResource, OrderFolderResource } from '../interfaces/Resource'
import Ordering from '../interfaces/Ordering'

const PAGE_SIZE = 300
const TIMEOUT = 180000

export interface NextcloudFoldersConfig {
  type: 'nextcloud-folders'
  url: string
  username: string
  password: string
  serverRoot?: string
}

interface IChildFolder {
  id: string|number
  title: string
  parentId?: string|number
  children?: IChildFolder[]
}

interface IChildOrderItem {
  type: 'bookmark' | 'folder'
  id: string|number
  children?: IChildOrderItem[]
}

export default class NextcloudFoldersAdapter implements Adapter, BulkImportResource, LoadFolderChildrenResource, OrderFolderResource {
  private server: NextcloudFoldersConfig
  private fetchQueue: PQueue<{ concurrency: 12 }>
  private bookmarkLock: AsyncLock
  public hasFeatureHashing:boolean = null
  public hasFeatureExistenceCheck:boolean = null
  public hasFeatureChildren:boolean = null
  public hasFeatureBulkImport:boolean = null
  private list: Bookmark[]
  private tree: Folder

  constructor(server: NextcloudFoldersConfig) {
    this.server = server
    this.fetchQueue = new PQueue({ concurrency: 12 })
    this.bookmarkLock = new AsyncLock()
    this.hasFeatureHashing = false
    this.hasFeatureExistenceCheck = false
  }

  static getDefaultValues(): NextcloudFoldersConfig {
    return {
      type: 'nextcloud-folders',
      url: 'https://example.org',
      username: 'bob',
      password: 's3cret',
      serverRoot: '',
    }
  }

  setData(data:NextcloudFoldersConfig):void {
    this.server = { ...data }
  }

  getData():NextcloudFoldersConfig {
    return { ...this.server }
  }

  getLabel():string {
    const data = this.getData()
    return data.username + '@' + url.parse(data.url).hostname
  }

  acceptsBookmark(bm: Bookmark):boolean {
    return Boolean(~['https:', 'http:', 'ftp:'].indexOf(url.parse(bm.url).protocol))
  }

  normalizeServerURL(input:string):string {
    const serverURL = url.parse(input)
    const indexLoc = serverURL.pathname.indexOf('index.php')
    return url.format({
      protocol: serverURL.protocol,
      auth: serverURL.auth,
      host: serverURL.host,
      port: serverURL.port,
      pathname:
        serverURL.pathname.substr(0, ~indexLoc ? indexLoc : undefined) +
        (!~indexLoc && serverURL.pathname[serverURL.pathname.length - 1] !== '/'
          ? '/'
          : ''),
    })
  }

  getLockUrl():string {
    return this.server.url + '/remote.php/webdav/.floccus-' + Base64.toBase64(this.server.serverRoot) + '.lock'
  }

  timeout(ms:number):Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  async onSyncStart():Promise<void> {
    Logger.log('onSyncStart: begin')
    await this.obtainLock()
  }

  async onSyncFail():Promise<void> {
    Logger.log('onSyncFail')
    await this.freeLock()
  }

  async onSyncComplete():Promise<void> {
    Logger.log('onSyncComplete')
    await this.freeLock()
  }

  async downloadFile(fullURL:string):Promise<Response> {
    let res
    const authString = Base64.encode(
      this.server.username + ':' + this.server.password
    )

    try {
      res = await fetch(fullURL, {
        method: 'GET',
        credentials: 'omit',
        headers: {
          Authorization: 'Basic ' + authString
        }
      })
    } catch (e) {
      throw new Error(browser.i18n.getMessage('Error017'))
    }

    if (res.status === 401) {
      throw new Error(browser.i18n.getMessage('Error018'))
    }
    if (!res.ok && res.status !== 404) {
      throw new Error(browser.i18n.getMessage('Error019', [res.status, 'GET']))
    }

    return res
  }

  async uploadFile(url:string, content_type:string, data:string):Promise<void> {
    const authString = Base64.encode(
      this.server.username + ':' + this.server.password
    )
    let res
    try {
      res = await fetch(url, {
        method: 'PUT',
        credentials: 'omit',
        headers: {
          'Content-Type': content_type,
          Authorization: 'Basic ' + authString
        },
        body: data
      })
    } catch (e) {
      Logger.log('Error Caught')
      Logger.log(e)
      throw new Error(browser.i18n.getMessage('Error017'))
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(browser.i18n.getMessage('Error018') + ' ' + browser.i18n.getMessage('DescriptionFilesPermission'))
    }
    if (!res.ok) {
      throw new Error(browser.i18n.getMessage('Error019', [res.status, 'PUT']))
    }
  }

  async checkLock(): Promise<number> {
    const fullURL = this.getLockUrl()
    Logger.log(fullURL)

    const response = await this.downloadFile(fullURL)
    return response.status
  }

  async obtainLock():Promise<void> {
    let rStatus
    const maxTimeout = 30 * 60 * 1000 // Give up after 0.5h
    const base = 1.25
    for (let i = 0; 1 / Math.log(base) * base ** i * 1000 < maxTimeout; i++) {
      rStatus = await this.checkLock()
      if (rStatus === 200) {
        await this.timeout(base ** i * 1000)
      } else if (rStatus === 404) {
        break
      }
    }

    if (rStatus === 200) {
      throw new Error(
        browser.i18n.getMessage('Error023', this.getLockUrl())
      )
    } else if (rStatus === 404) {
      const fullURL = this.getLockUrl()
      Logger.log(fullURL)
      await this.uploadFile(
        fullURL,
        'text/html',
        '<html><body>I am a lock file</body></html>'
      )
    } else {
      throw new Error(
        browser.i18n.getMessage('Error024', [
          rStatus,
          this.getLockUrl()
        ])
      )
    }
  }

  async freeLock():Promise<void> {
    const fullUrl = this.getLockUrl()

    const authString = Base64.encode(
      this.server.username + ':' + this.server.password
    )

    try {
      await fetch(fullUrl, {
        method: 'DELETE',
        credentials: 'omit',
        headers: {
          Authorization: 'Basic ' + authString
        }
      })
    } catch (e) {
      Logger.log(e)
    }
  }

  async getBookmarksList():Promise<Bookmark[]> {
    return this.bookmarkLock.acquire('list', async() => {
      if (this.list) {
        return this.list
      }

      Logger.log('Fetching bookmarks')
      let i = 0
      let data = []
      let json
      do {
        json = await this.sendRequest(
          'GET',
          `index.php/apps/bookmarks/public/rest/v2/bookmark?page=${i}&limit=${PAGE_SIZE}`
        )
        if (!Array.isArray(json.data)) {
          throw new Error(browser.i18n.getMessage('Error015'))
        }
        data = data.concat(json.data)
        i++
      } while (json.data.length === PAGE_SIZE)

      const bookmarks = flatten(
        data.map((bm) => {
          const bookmark = {
            id: bm.id as number | string,
            url: bm.url as string,
            title: bm.title as string,
            parentId: null
          }

          return bm.folders.map((parentId) => {
            const b = { ...bookmark }
            b.parentId = parentId
            return new Bookmark(b)
          })
        })
      )

      Logger.log('Received bookmarks from server', bookmarks)
      this.list = bookmarks
      return bookmarks
    })
  }

  async getBookmarksTree(loadAll = false):Promise<Folder> {
    this.list = null // clear cache before starting a new sync

    // feature detection: Check if the server offers hashes
    const hashResponse = await this.sendRequest(
      'GET',
      'index.php/apps/bookmarks/public/rest/v2/folder/-1/hash',
      null,
      null,
      true
    )
    let json
    try {
      json = await hashResponse.json()
    } catch (e) {
      // noop
    }

    if (
      !loadAll &&
      ((hashResponse.status === 200 && json && json.status === 'success') ||
        hashResponse.status === 504)
    ) {
      return this.getSparseBookmarksTree()
    } else {
      this.hasFeatureHashing = false
      return this.getCompleteBookmarksTree()
    }
  }

  async _getChildOrder(folderId:string|number, layers:number):Promise<IChildOrderItem[]> {
    const childrenOrderJson = await this.sendRequest(
      'GET',
      `index.php/apps/bookmarks/public/rest/v2/folder/${folderId}/childorder` +
        (layers ? `?layers=${layers}` : '')
    )
    if (!Array.isArray(childrenOrderJson.data)) {
      throw new Error(browser.i18n.getMessage('Error015'))
    }
    return childrenOrderJson.data
  }

  async _getChildFolders(folderId:string|number, layers = 0):Promise<IChildFolder[]> {
    const folderJson = await this.sendRequest(
      'GET',
      `index.php/apps/bookmarks/public/rest/v2/folder?root=${folderId}&layers=${layers}`
    )
    if (!Array.isArray(folderJson.data)) {
      throw new Error(browser.i18n.getMessage('Error015'))
    }
    return folderJson.data
  }

  async _findServerRoot():Promise<Folder> {
    let tree = new Folder({ id: -1, })
    let childFolders
    await Parallel.each(
      this.server.serverRoot.split('/').slice(1),
      async(segment) => {
        childFolders = (tree.children && tree.children.length) ? tree.children : (await this._getChildFolders(tree.id))
        let currentChild = childFolders.find(
          (folder) => folder.title === segment
        )
        if (!currentChild) {
          // create folder
          const body = JSON.stringify({
            parent_folder: tree.id,
            title: segment,
          })
          const json = await this.sendRequest(
            'POST',
            'index.php/apps/bookmarks/public/rest/v2/folder',
            'application/json',
            body
          )
          if (typeof json.item !== 'object') {
            throw new Error(browser.i18n.getMessage('Error015'))
          }
          currentChild = { id: json.item.id, children: [], title: json.item.title }
        }
        tree = new Folder({ id: currentChild.id, title: currentChild.title })
      },
      1
    )
    return tree
  }

  async getCompleteBookmarksTree():Promise<Folder> {
    let tree = new Folder({ id: '-1', })
    if (this.server.serverRoot) {
      tree = await this._findServerRoot()
    }

    await this.getBookmarksList()
    tree.children = await this._getChildren(tree.id, -1)
    this.tree = tree
    return tree.clone()
  }

  async getSparseBookmarksTree() :Promise<Folder> {
    this.hasFeatureHashing = true
    this.hasFeatureExistenceCheck = true

    let tree = new Folder({ id: -1 })

    if (this.server.serverRoot) {
      tree = await this._findServerRoot()
    }

    this.list = null
    tree.hashValue = { true: await this._getFolderHash(tree.id) }
    this.tree = tree.clone(true) // we clone (withHash), so we can mess with our own version
    return tree
  }

  async _getFolderHash(folderId:string|number):Promise<string> {
    return this.sendRequest(
      'GET',
      `index.php/apps/bookmarks/public/rest/v2/folder/${folderId}/hash`
    )
      .catch(() => {
        return { data: '0' } // fallback
      })
      .then((json) => {
        return json.data
      })
  }

  async _getChildren(folderId:string|number, layers:number):Promise<TItem[]> {
    let childrenJson
    if (
      this.hasFeatureChildren === null ||
      this.hasFeatureChildren
    ) {
      try {
        childrenJson = await this.sendRequest(
          'GET',
          `index.php/apps/bookmarks/public/rest/v2/folder/${folderId}/children?layers=${layers}`
        )
        this.hasFeatureChildren = true
      } catch (e) {
        this.hasFeatureChildren = false
      }
    }
    if (this.hasFeatureChildren) {
      const children = childrenJson.data
      const recurseChildren = (folderId, children) => {
        return children.map((item) => {
          if (item.type === 'bookmark') {
            return new Bookmark({
              id: item.id + ';' + folderId,
              title: item.title,
              parentId: folderId,
              url: item.url,
            })
          } else if (item.type === 'folder') {
            const childFolder = new Folder({
              id: item.id,
              parentId: folderId,
              title: item.title,
            })
            childFolder.loaded = Boolean(item.children)
            childFolder.children = recurseChildren(item.id, item.children || [])
            return childFolder
          }
        })
      }
      return recurseChildren(folderId, children)
    } else {
      const [childrenOrder, childFolders, childBookmarks] = await Promise.all([
        this._getChildOrder(folderId, layers),
        this._getChildFolders(folderId, layers),
        Promise.resolve().then(
          () =>
            this.list ||
            this.sendRequest(
              'GET',
              `index.php/apps/bookmarks/public/rest/v2/bookmark?folder=${folderId}&page=-1`
            ).then((json) => json.data)
        ),
      ])
      const recurseFolders = (folderId, childFolders) => {
        if (!childFolders) return []
        return childFolders.map((child) => {
          if (child instanceof Folder) {
            return child
          }
          const childFolder = new Folder({
            id: child.id,
            parentId: folderId,
            title: child.title,
          })
          childFolder.children = recurseFolders(child.id, child.children)
          return childFolder
        })
      }
      const folder = new Folder({
        id: folderId,
        children: recurseFolders(folderId, childFolders),
      })
      const recurseItems = (folderId, childrenOrder) => {
        return childrenOrder.map((item) => {
          if (item.type === 'bookmark') {
            const bm = childBookmarks.find(
              (child) => String(child.id) === String(item.id)
            )
            if (!bm) {
              throw new Error('Could not find bookmark ' + item.id)
            }
            if (bm instanceof Bookmark) return bm // in case we've got this from the cached list
            return new Bookmark({
              id: bm.id + ';' + folderId,
              title: bm.title,
              parentId: folderId,
              url: bm.url,
            })
          } else if (item.type === 'folder') {
            const f = folder.findFolder(item.id)
            f.children = recurseItems(f.id, item.children)
            return f
          }
        })
      }
      return recurseItems(folderId, childrenOrder)
    }
  }

  async loadFolderChildren(folderId:string|number): Promise<TItem[]> {
    if (!this.hasFeatureHashing) {
      return
    }
    const folder = this.tree.findFolder(folderId)
    if (folder.loaded) {
      return folder.clone(true).children
    }
    const children = await this._getChildren(folderId, 1)
    const recurse = async(children) => {
      return Parallel.each(children, async(child) => {
        if (!(child instanceof Folder)) {
          return
        }
        if (!child.loaded) {
          const folderHash = await this._getFolderHash(child.id)
          child.hashValue = { true: folderHash }
        }
        await recurse(child.children)
      })
    }
    await recurse(children)
    folder.children = children
    this.tree.createIndex()
    return folder.clone(true).children
  }

  async createFolder(folder:Folder):Promise<string|number> {
    Logger.log('(nextcloud-folders)CREATEFOLDER', {folder})
    const parentId = folder.parentId
    const title = folder.title

    const parentFolder = this.tree.findFolder(parentId)
    if (!parentFolder) {
      throw new Error(browser.i18n.getMessage('Error005'))
    }
    const body = JSON.stringify({
      parent_folder: parentId,
      title: title,
    })
    const json = await this.sendRequest(
      'POST',
      'index.php/apps/bookmarks/public/rest/v2/folder',
      'application/json',
      body
    )
    if (typeof json.item !== 'object') {
      throw new Error(browser.i18n.getMessage('Error015'))
    }

    parentFolder.children.push(
      new Folder({ id: json.item.id, title, parentId })
    )
    this.tree.createIndex()
    return json.item.id
  }

  async bulkImportFolder(parentId:string|number, folder:Folder):Promise<Folder> {
    if (this.hasFeatureBulkImport === false) {
      throw new Error('Current server does not support bulk import')
    }
    if (folder.count() > 300) {
      throw new Error('Refusing to bulk import more than 300 bookmarks')
    }
    Logger.log('(nextcloud-folders)BULKIMPORT', { parentId, folder })
    const parentFolder = this.tree.findFolder(parentId)
    if (!parentFolder) {
      throw new Error(browser.i18n.getMessage('Error005'))
    }
    const blob = new Blob(
      [
        '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n',
        '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n',
        HtmlSerializer.serialize(folder),
      ],
      {
        type: 'text/html',
      }
    )
    const body = new FormData()
    body.append('bm_import', blob)
    let json
    try {
      json = await this.sendRequest(
        'POST',
        `index.php/apps/bookmarks/public/rest/v2/folder/${parentId}/import`,
        null,
        body
      )
    } catch (e) {
      this.hasFeatureBulkImport = false
    }

    const recurseChildren = (children, id, title, parentId) => {
      return new Folder({
        id,
        title,
        parentId,
        children: children.map((item) => {
          if (item.type === 'bookmark') {
            return new Bookmark({
              id: item.id + ';' + id,
              title: item.title,
              url: item.url,
              parentId: id,
            })
          } else if (item.type === 'folder') {
            return recurseChildren(item.children, item.id, item.title, id)
          } else {
            console.log('PEBCAK', item)
            throw new Error('PEBKAC')
          }
        }),
      })
    }
    const imported = recurseChildren(json.data, parentId, folder.title, folder.parentId)
    parentFolder.children = imported.clone(true).children
    this.tree.createIndex()
    return imported
  }

  async updateFolder(folder:Folder):Promise<void> {
    Logger.log('(nextcloud-folders)UPDATEFOLDER', { folder })
    const id = folder.id
    const oldFolder = this.tree.findFolder(folder.id)
    if (oldFolder.findFolder(folder.parentId)) {
      throw new Error('Detected folder loop creation')
    }
    const body = JSON.stringify({
      parent_folder: folder.parentId,
      title: folder.title,
    })
    await this.sendRequest(
      'PUT',
      `index.php/apps/bookmarks/public/rest/v2/folder/${id}`,
      'application/json',
      body
    )
    const oldParentFolder = this.tree.findFolder(oldFolder.parentId)
    if (!oldParentFolder) {
      throw new Error(browser.i18n.getMessage('Error008'))
    }
    oldParentFolder.children = oldParentFolder.children.filter(
      (child) => String(child.id) !== String(id)
    )
    const newParentFolder = this.tree.findFolder(folder.parentId)
    if (!newParentFolder) {
      throw new Error(browser.i18n.getMessage('Error009'))
    }
    newParentFolder.children.push(oldFolder)
    oldFolder.title = folder.title
    oldFolder.parentId = folder.parentId
    this.tree.createIndex()
  }

  async orderFolder(id:string|number, order:Ordering):Promise<void> {
    Logger.log('(nextcloud-folders)ORDERFOLDER', { id, order })
    const body = {
      data: order.map((item) => ({
        id: String(item.id).split(';')[0],
        type: item.type,
      })),
    }
    await this.sendRequest(
      'PATCH',
      `index.php/apps/bookmarks/public/rest/v2/folder/${id}/childorder`,
      'application/json',
      JSON.stringify(body)
    )
  }

  async removeFolder(folder:Folder):Promise<void> {
    Logger.log('(nextcloud-folders)REMOVEFOLDER', { folder })
    const id = folder.id
    const oldFolder = this.tree.findFolder(id)
    if (!oldFolder) {
      return
    }
    await this.sendRequest(
      'DELETE',
      `index.php/apps/bookmarks/public/rest/v2/folder/${id}`
    )
    const parent = this.tree.findFolder(oldFolder.parentId)
    parent.children = parent.children.filter(
      (child) => String(child.id) !== String(id)
    )

    this.tree.createIndex()
  }

  async _getBookmark(id:string|number):Promise<Bookmark[]> {
    Logger.log('Fetching single bookmark')

    const json = await this.sendRequest(
      'GET',
      'index.php/apps/bookmarks/public/rest/v2/bookmark/' + id
    )
    if (typeof json.item !== 'object') {
      throw new Error(browser.i18n.getMessage('Error015'))
    }

    const bm = json.item
    if (!bm.folders.length) {
      bm.folders = [null]
    }
    return bm.folders.map((parentId) => {
      return new Bookmark({
        id: bm.id + ';' + parentId,
        url: bm.url,
        title: bm.title,
        parentId: parentId,
        tags: bm.tags
      })
    })
  }

  /*
   * This is pretty expensive! We need to wait until NcBookmarks has support for
   * querying urls directly
   */
  async getExistingBookmark(url:string):Promise<false|string|number> {
    if (this.hasFeatureExistenceCheck) {
      const json = await this.sendRequest(
        'GET',
        `index.php/apps/bookmarks/public/rest/v2/bookmark?url=${encodeURIComponent(
          url
        )}`
      )
      if (json.data.length) {
        return json.data[0].id
      } else {
        return false
      }
    } else {
      await this.getBookmarksList()
      const existing = this.list.find((bookmark) => bookmark.url === url)
      if (!existing) return false
      return existing.id
    }
  }

  async createBookmark(bm:Bookmark):Promise<string|number> {
    Logger.log('(nextcloud-folders)CREATE', bm)

    // We need this lock to avoid creating two boomarks with the same url
    // in parallel
    return this.bookmarkLock.acquire(bm.url, async() => {
      const existingBookmark = await this.getExistingBookmark(bm.url)
      if (existingBookmark) {
        bm.id = existingBookmark + ';' + bm.parentId
        await this.updateBookmark(bm)
      } else {
        const body = JSON.stringify({
          url: bm.url,
          title: bm.title,
          folders: [bm.parentId],
        })

        const json = await this.sendRequest(
          'POST',
          'index.php/apps/bookmarks/public/rest/v2/bookmark',
          'application/json',
          body
        )
        if (typeof json.item !== 'object') {
          throw new Error(browser.i18n.getMessage('Error015'))
        }
        bm.id = json.item.id + ';' + bm.parentId
      }
      // add bookmark to cached list
      const upstreamMark = bm.clone()
      upstreamMark.id = bm.id.split(';')[0]
      this.list && this.list.push(upstreamMark)

      return bm.id
    })
  }

  async updateBookmark(newBm:Bookmark):Promise<void> {
    Logger.log('(nextcloud-folders)UPDATE', newBm)

    const [upstreamId, oldParentId] = String(newBm.id).split(';')

    // We need this lock to avoid updating bookmarks which are in two places at Once
    // in parallel
    return this.bookmarkLock.acquire(upstreamId, async() => {
      const bms = await this._getBookmark(upstreamId)

      const body = JSON.stringify({
        url: newBm.url,
        title: newBm.title,
        folders: bms
          .map((bm) => bm.parentId)
          .filter(
            (parentId) =>
              parentId && String(parentId) !== String(oldParentId)
          )
          .concat([newBm.parentId]),
        tags: bms[0].tags,
      })

      await this.sendRequest(
        'PUT',
        `index.php/apps/bookmarks/public/rest/v2/bookmark/${upstreamId}`,
        'application/json',
        body
      )

      return upstreamId + ';' + newBm.parentId
    })
  }

  async removeBookmark(bookmark:Bookmark):Promise<void> {
    Logger.log('(nextcloud-folders)REMOVE', { bookmark })
    const id = bookmark.id
    const [upstreamId, parentId] = String(id).split(';')

    // Just to be safe
    return this.bookmarkLock.acquire(upstreamId, async() => {
      await this.sendRequest(
        'DELETE',
        `index.php/apps/bookmarks/public/rest/v2/folder/${parentId}/bookmarks/${upstreamId}`
      )

      // remove bookmark from the cached list
      const list = await this.getBookmarksList()
      const listIndex = list.findIndex(
        (bookmark) => String(bookmark.id) === String(upstreamId)
      )
      list.splice(listIndex, 1)
    })
  }

  async sendRequest(verb:string, relUrl:string, type:string = null, body:any = null, returnRawResponse = false):Promise<any> {
    const url = this.normalizeServerURL(this.server.url) + relUrl
    let res
    let timedOut = false
    const authString = Base64.encode(
      this.server.username + ':' + this.server.password
    )
    try {
      res = await this.fetchQueue.add(() =>
        Promise.race([
          fetch(url, {
            method: verb,
            credentials: 'omit',
            headers: {
              ...(type && { 'Content-type': type }),
              Authorization: 'Basic ' + authString,
            },
            ...(body && { body }),
          }),
          new Promise((resolve, reject) =>
            setTimeout(() => {
              timedOut = true
              reject(new Error(browser.i18n.getMessage('Error016')))
            }, TIMEOUT)
          ),
        ])
      )
    } catch (e) {
      if (timedOut) throw e
      throw new Error(browser.i18n.getMessage('Error017'))
    }

    if (returnRawResponse) {
      return res
    }

    if (res.status === 401 || res.status === 403) {
      throw new Error(browser.i18n.getMessage('Error018'))
    }
    if (res.status === 503) {
      throw new Error(browser.i18n.getMessage('Error019', [res.status, verb]))
    }
    let json
    try {
      json = await res.json()
    } catch (e) {
      throw new Error(browser.i18n.getMessage('Error020') + '\n' + e.message)
    }
    if (json.status !== 'success') {
      throw new Error('Nextcloud API error: \n' + JSON.stringify(json))
    }

    return json
  }
}
