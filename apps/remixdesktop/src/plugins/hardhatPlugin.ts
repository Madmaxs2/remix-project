import { Profile } from "@remixproject/plugin-utils";
import { ElectronBasePlugin, ElectronBasePluginClient } from "@remixproject/plugin-electron"
import chokidar from 'chokidar'
import { ElectronBasePluginRemixdClient } from "../lib/remixd"
import fs from 'fs'
import * as utils from '../lib/utils'

import { basename, join } from "path";
import { spawn } from "child_process";
const profile: Profile = {
    name: 'hardhat',
    displayName: 'electron slither',
    description: 'electron slither',
}

export class HardhatPlugin extends ElectronBasePlugin {
    clients: any[]
    constructor() {
        super(profile, clientProfile, HardhatPluginClient)
        this.methods = [...super.methods]
    }
}

const clientProfile: Profile = {
    name: 'hardhat',
    displayName: 'electron hardhat',
    description: 'electron hardhat',
    methods: ['sync', 'compile']
}


class HardhatPluginClient extends ElectronBasePluginRemixdClient {
    watcher: chokidar.FSWatcher
    warnlog: boolean
    buildPath: string
    cachePath: string
    logTimeout: NodeJS.Timeout
    processingTimeout: NodeJS.Timeout

    async onActivation(): Promise<void> {
        console.log('Hardhat plugin activated')
        this.call('terminal', 'log', { type: 'log', value: 'Hardhat plugin activated' })
        this.startListening()
        this.on('fs' as any, 'workingDirChanged', async (path: string) => {
            console.log('workingDirChanged hardhat', path)
            this.currentSharedFolder = path
            this.startListening()
        })
        this.currentSharedFolder = await this.call('fs' as any, 'getWorkingDir')
    }

    startListening() {
        this.buildPath = utils.absolutePath('artifacts/contracts', this.currentSharedFolder)
        if (fs.existsSync(this.buildPath)) {
          this.listenOnHardhatCompilation()
        } else {
          console.log('If you are using Hardhat, run `npx hardhat compile` or run the compilation with `Enable Hardhat Compilation` checked from the Remix IDE.')
          this.listenOnHardHatFolder()
        }
      }
    
      compile(configPath: string) {
        return new Promise((resolve, reject) => {
          const cmd = `npx hardhat compile --config ${utils.normalizePath(configPath)}`
          const options = { cwd: this.currentSharedFolder, shell: true }
          const child = spawn(cmd, options)
          let result = ''
          let error = ''
          child.stdout.on('data', (data) => {
            const msg = `[Hardhat Compilation]: ${data.toString()}`
            console.log('\x1b[32m%s\x1b[0m', msg)
            result += msg + '\n'
          })
          child.stderr.on('data', (err) => {
            error += `[Hardhat Compilation]: ${err.toString()} \n`
          })
          child.on('close', () => {
            if (error && result) resolve(error + result)
            else if (error) reject(error)
            else resolve(result)
          })
        })
      }
    
      checkPath() {
        if (!fs.existsSync(this.buildPath)) {
          this.listenOnHardHatFolder()
          return false
        }
        return true
      }
    
      private async processArtifact() {
        console.log('processing artifact')
        if (!this.checkPath()) return
        // resolving the files
        const folderFiles = await fs.promises.readdir(this.buildPath)
        const targetsSynced = []
        // name of folders are file names
        for (const file of folderFiles) { // ["artifacts/contracts/Greeter.sol/"]
          const contractFilePath = join(this.buildPath, file)
          const stat = await fs.promises.stat(contractFilePath)
          if (!stat.isDirectory()) continue
          const files = await fs.promises.readdir(contractFilePath)
          const compilationResult = {
            input: {},
            output: {
              contracts: {},
              sources: {}
            },
            solcVersion: null,
            target: null
          }
          for (const file of files) {
            if (file.endsWith('.dbg.json')) { // "artifacts/contracts/Greeter.sol/Greeter.dbg.json"
              const stdFile = file.replace('.dbg.json', '.json')
              const contentStd = await fs.promises.readFile(join(contractFilePath, stdFile), { encoding: 'utf-8' })
              const contentDbg = await fs.promises.readFile(join(contractFilePath, file), { encoding: 'utf-8' })
              const jsonDbg = JSON.parse(contentDbg)
              const jsonStd = JSON.parse(contentStd)
              compilationResult.target = jsonStd.sourceName
    
              targetsSynced.push(compilationResult.target)
              const path = join(contractFilePath, jsonDbg.buildInfo)
              const content = await fs.promises.readFile(path, { encoding: 'utf-8' })
    
              await this.feedContractArtifactFile(content, compilationResult)
            }
            if (compilationResult.target) {
              // we are only interested in the contracts that are in the target of the compilation
              compilationResult.output = {
                ...compilationResult.output,
                contracts: { [compilationResult.target]: compilationResult.output.contracts[compilationResult.target] }
              }
              this.emit('compilationFinished', compilationResult.target, { sources: compilationResult.input }, 'soljson', compilationResult.output, compilationResult.solcVersion)
            }
          }
        }
    
        clearTimeout(this.logTimeout)
        this.logTimeout = setTimeout(() => {
          this.call('terminal', 'log', { value: 'receiving compilation result from Hardhat. Select a file to populate the contract interaction interface.', type: 'log' })
          if (targetsSynced.length) {
            console.log(`Processing artifacts for files: ${[...new Set(targetsSynced)].join(', ')}`)
            // @ts-ignore
            this.call('terminal', 'log', { type: 'log', value: `synced with Hardhat: ${[...new Set(targetsSynced)].join(', ')}` })
          } else {
            console.log('No artifacts to process')
            // @ts-ignore
            this.call('terminal', 'log', { type: 'log', value: 'No artifacts from Hardhat to process' })
          }
        }, 1000)
    
      }
    
      listenOnHardHatFolder() {
        console.log('Hardhat artifacts folder doesn\'t exist... waiting for the compilation.')
        try {
          if (this.watcher) this.watcher.close()
          this.watcher = chokidar.watch(this.currentSharedFolder, { depth: 2, ignorePermissionErrors: true, ignoreInitial: true })
          // watch for new folders
          this.watcher.on('addDir', (path: string) => {
            console.log('add dir hardhat', path)
            if (fs.existsSync(this.buildPath)) {
              this.listenOnHardhatCompilation()
            }
          })
        } catch (e) {
          console.log('listenOnHardHatFolder', e)
        }
      }
    
      async triggerProcessArtifact() {
        console.log('triggerProcessArtifact')
        // prevent multiple calls
        clearTimeout(this.processingTimeout)
        this.processingTimeout = setTimeout(async () => await this.processArtifact(), 1000)
      }
    
      listenOnHardhatCompilation() {
        try {
          console.log('listening on Hardhat compilation...', this.buildPath)
          if (this.watcher) this.watcher.close()
          this.watcher = chokidar.watch(this.buildPath, { depth: 1, ignorePermissionErrors: true, ignoreInitial: true })
          this.watcher.on('change', async () => await this.triggerProcessArtifact())
          this.watcher.on('add', async () => await this.triggerProcessArtifact())
          this.watcher.on('unlink', async () => await this.triggerProcessArtifact())
          // process the artifact on activation
          this.processArtifact()
        } catch (e) {
          console.log('listenOnHardhatCompilation', e)
        }
      }
    
      async sync() {
        console.log('syncing from Hardhat')
        this.processArtifact()
      }
    
      async feedContractArtifactFile(artifactContent, compilationResultPart) {
        const contentJSON = JSON.parse(artifactContent)
        compilationResultPart.solcVersion = contentJSON.solcVersion
        for (const file in contentJSON.input.sources) {
          const source = contentJSON.input.sources[file]
          const absPath = join(this.currentSharedFolder, file)
          if (fs.existsSync(absPath)) { // if not that is a lib
            const contentOnDisk = await fs.promises.readFile(absPath, { encoding: 'utf-8' })
            if (contentOnDisk === source.content) {
              compilationResultPart.input[file] = source
              compilationResultPart.output['sources'][file] = contentJSON.output.sources[file]
              compilationResultPart.output['contracts'][file] = contentJSON.output.contracts[file]
              if (contentJSON.output.errors && contentJSON.output.errors.length) {
                compilationResultPart.output['errors'] = contentJSON.output.errors.filter(error => error.sourceLocation.file === file)
              }
            }
          }
        }
      }
}