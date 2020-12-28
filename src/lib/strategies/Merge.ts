import { Folder, ItemType } from '../Tree'
import Diff, { Action, ActionType } from '../Diff'
import Scanner from '../Scanner'
import * as Parallel from 'async-parallel'
import Default from './Default'
import { Mapping } from '../Mappings'

export default class MergeSyncProcess extends Default {
  async getDiffs():Promise<{localDiff:Diff, serverDiff:Diff}> {
    // If there's no cache, diff the two trees directly
    const newMappings = []
    const localScanner = new Scanner(
      this.serverTreeRoot,
      this.localTreeRoot,
      (serverItem, localItem) => {
        if (localItem.type === serverItem.type && serverItem.canMergeWith(localItem)) {
          newMappings.push([localItem, serverItem])
          return true
        }
        return false
      },
      this.preserveOrder,
      false
    )
    const serverScanner = new Scanner(
      this.localTreeRoot,
      this.serverTreeRoot,
      (localItem, serverItem) => {
        if (serverItem.type === localItem.type && serverItem.canMergeWith(localItem)) {
          newMappings.push([localItem, serverItem])
          return true
        }
        return false
      },
      this.preserveOrder,
      false
    )
    const [localDiff, serverDiff] = await Promise.all([localScanner.run(), serverScanner.run()])
    await Promise.all(newMappings.map(([localItem, serverItem]) => {
      this.addMapping(this.server, localItem, serverItem.id)
    }))
    return {localDiff, serverDiff}
  }

  async reconcile(localDiff:Diff, serverDiff:Diff):Promise<{serverPlan: Diff, localPlan: Diff}> {
    const mappingsSnapshot = await this.mappings.getSnapshot()

    const serverCreations = serverDiff.getActions(ActionType.CREATE)
    const serverMoves = serverDiff.getActions(ActionType.MOVE)

    const localCreations = localDiff.getActions(ActionType.CREATE)
    const localMoves = localDiff.getActions(ActionType.MOVE)
    const localUpdates = localDiff.getActions(ActionType.UPDATE)

    // Prepare server plan
    const serverPlan = new Diff() // to be mapped
    await Parallel.each(localDiff.getActions(), async(action:Action) => {
      if (action.type === ActionType.REMOVE) {
        // don't execute deletes
        return
      }
      if (action.type === ActionType.CREATE) {
        const concurrentCreation = serverCreations.find(a =>
          action.payload.parentId === mappingsSnapshot.ServerToLocal.folder[a.payload.parentId] &&
          action.payload.canMergeWith(a.payload))
        if (concurrentCreation) {
          // created on both the server and locally, try to reconcile
          const newMappings = []
          const subScanner = new Scanner(
            concurrentCreation.payload, // server tree
            action.payload, // local tree
            (oldItem, newItem) => {
              if (oldItem.type === newItem.type && oldItem.canMergeWith(newItem)) {
                // if two items can be merged, we'll add mappings here directly
                newMappings.push([oldItem, newItem.id])
                return true
              }
              return false
            },
            this.preserveOrder,
            false
          )
          await subScanner.run()
          newMappings.push([concurrentCreation.payload, action.payload.id])
          await Parallel.each(newMappings, async([oldItem, newId]) => {
            await this.addMapping(this.localTree, oldItem, newId)
          },1)
          // TODO: subScanner may contain residual CREATE/REMOVE actions that need to be added to mappings
          return
        }
      }
      if (action.type === ActionType.MOVE) {
        const concurrentHierarchyReversals = serverMoves.filter(a => {
          const serverFolder = this.serverTreeRoot.findItem(ItemType.FOLDER, a.payload.id)
          const localFolder = this.localTreeRoot.findItem(ItemType.FOLDER, action.payload.id)

          const localAncestors = Folder.getAncestorsOf(this.localTreeRoot.findItem(ItemType.FOLDER, action.payload.parentId), this.localTreeRoot)
          const serverAncestors = Folder.getAncestorsOf(this.serverTreeRoot.findItem(ItemType.FOLDER, a.payload.parentId), this.serverTreeRoot)

          // If both items are folders, and one of the ancestors of one item is a child of the other item
          return action.payload.type === ItemType.FOLDER && a.payload.type === ItemType.FOLDER &&
            localAncestors.find(ancestor => serverFolder.findItem(ItemType.FOLDER, mappingsSnapshot.LocalToServer.folder[ancestor.id])) &&
            serverAncestors.find(ancestor => localFolder.findItem(ItemType.FOLDER, mappingsSnapshot.ServerToLocal.folder[ancestor.id]))
        })
        if (concurrentHierarchyReversals.length) {
          concurrentHierarchyReversals.forEach(a => {
            // moved locally but moved in reverse hierarchical order on server
            const payload = a.oldItem.clone() // we don't map here as we want this to look like a local action
            const oldItem = a.payload.clone()
            oldItem.id = mappingsSnapshot.ServerToLocal[oldItem.type ][oldItem.id]
            oldItem.parentId = mappingsSnapshot.ServerToLocal.folder[oldItem.parentId]

            if (
              serverPlan.getActions(ActionType.MOVE).find(move => move.payload.id === payload.id) ||
              localDiff.getActions(ActionType.MOVE).find(move => move.payload.id === payload.id)
            ) {
              // Don't create duplicates!
              return
            }

            // revert server move
            serverPlan.commit({...a, payload, oldItem})
          })
          serverPlan.commit(action)
          return
        }
      }
      if (action.type === ActionType.REORDER) {
        // Don't reorder in first sync
        return
      }

      serverPlan.commit(action)
    })

    // Map payloads
    serverPlan.map(mappingsSnapshot.LocalToServer, true, (action) => action.type !== ActionType.REORDER && action.type !== ActionType.MOVE)

    // Prepare local plan
    const localPlan = new Diff()
    await Parallel.each(serverDiff.getActions(), async(action:Action) => {
      if (action.type === ActionType.REMOVE) {
        // don't execute deletes
        return
      }
      if (action.type === ActionType.CREATE) {
        const concurrentCreation = localCreations.find(a =>
          action.payload.parentId === mappingsSnapshot.LocalToServer.folder[a.payload.parentId] &&
          action.payload.canMergeWith(a.payload))
        if (concurrentCreation) {
          // created on both the server and locally, try to reconcile
          const newMappings = []
          const subScanner = new Scanner(
            concurrentCreation.payload,
            action.payload,
            (oldItem, newItem) => {
              if (oldItem.type === newItem.type && oldItem.canMergeWith(newItem)) {
                // if two items can be merged, we'll add mappings here directly
                newMappings.push([oldItem, newItem.id])
                return true
              }
              return false
            },
            this.preserveOrder,
            false,
          )
          await subScanner.run()
          // also add mappings for the two root folders
          newMappings.push([concurrentCreation.payload, action.payload.id])
          await Parallel.each(newMappings, async([oldItem, newId]) => {
            await this.addMapping(this.server, oldItem, newId)
          })
          // do nothing locally if the trees differ, serverPlan takes care of adjusting the server tree
          return
        }
      }
      if (action.type === ActionType.MOVE) {
        const concurrentMove = localMoves.find(a =>
          action.payload.id === mappingsSnapshot.LocalToServer[a.payload.type][a.payload.id])
        if (concurrentMove) {
          // Moved both on server and locally, local has precedence: do nothing locally
          return
        }
        const concurrentHierarchyReversals = localMoves.filter(a => {
          const serverFolder = this.serverTreeRoot.findItem(ItemType.FOLDER, action.payload.id)
          const localFolder = this.localTreeRoot.findItem(ItemType.FOLDER, a.payload.id)

          const localAncestors = Folder.getAncestorsOf(this.localTreeRoot.findItem(ItemType.FOLDER, a.payload.parentId), this.localTreeRoot)
          const serverAncestors = Folder.getAncestorsOf(this.serverTreeRoot.findItem(ItemType.FOLDER, action.payload.parentId), this.serverTreeRoot)

          // If both items are folders, and one of the ancestors of one item is a child of the other item
          return action.payload.type === ItemType.FOLDER && a.payload.type === ItemType.FOLDER &&
            localAncestors.find(ancestor => serverFolder.findItem(ItemType.FOLDER, mappingsSnapshot.LocalToServer.folder[ancestor.id])) &&
            serverAncestors.find(ancestor => localFolder.findItem(ItemType.FOLDER, mappingsSnapshot.ServerToLocal.folder[ancestor.id]))
        })
        if (concurrentHierarchyReversals.length) {
          // Moved locally and in reverse hierarchical order on server. local has precedence: do nothing locally
          return
        }
      }
      if (action.type === ActionType.UPDATE) {
        const concurrentUpdate = localUpdates.find(a =>
          action.payload.id === mappingsSnapshot.LocalToServer[a.payload.type ][a.payload.id])
        if (concurrentUpdate) {
          // Updated both on server and locally, local has precedence: do nothing locally
          return
        }
      }
      if (action.type === ActionType.REORDER) {
        // don't reorder in first sync
        return
      }
      localPlan.commit(action)
    })

    localPlan.map(mappingsSnapshot.ServerToLocal, false, (action) => action.type !== ActionType.REORDER && action.type !== ActionType.MOVE)

    return { localPlan, serverPlan}
  }

  reconcileReorderings(targetTreePlan:Diff, sourceTreePlan:Diff, sourceToTargetMappings:Mapping, isLocalToServer: boolean) : void {
    super.reconcileReorderings(targetTreePlan, sourceTreePlan, sourceToTargetMappings, true)
  }

  async loadChildren():Promise<void> {
    this.serverTreeRoot = await this.server.getBookmarksTree(true)
  }
}
