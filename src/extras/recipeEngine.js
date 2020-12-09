//Requires
const modulename = 'RecipeEngine';
const path = require('path');
const util = require('util');
const fs = require('fs-extra');
const AdmZip = require('adm-zip');
const axios = require("axios");
const cloneDeep = require('lodash/cloneDeep');
const escapeRegExp = require('lodash/escapeRegExp');
const mysql = require('mysql2/promise');
const { dir, log, logOk, logWarn, logError } = require('../extras/console')(modulename);

//Helper functions
const safePath = (base, suffix) => {
    const safeSuffix = path.normalize(suffix).replace(/^(\.\.(\/|\\|$))+/, '');
    return path.join(base, safeSuffix);
}
const isPathLinear = (pathInput) => {
    return pathInput.match(/(\.\.(\/|\\|$))+/g) === null;
}
const isPathRoot = (pathInput) => {
    return /^\.[\/\\]*$/.test(pathInput);
}
const pathCleanTrail = (pathInput) => {
    return pathInput.replace(/[\/\\]+$/, '');
} 
const isPathValid = (pathInput, acceptRoot=true) => {
    return (
        typeof pathInput == 'string' &&
        pathInput.length &&
        isPathLinear(pathInput) &&
        (acceptRoot || !isPathRoot(pathInput))
    )
}
const replaceVars = (inputString, deployerCtx) => {
    const allVars = Object.keys(deployerCtx);
    for (const varName of allVars) {
        const varNameReplacer = new RegExp(escapeRegExp(`{{${varName}}}`), 'g');
        inputString = inputString.replace(varNameReplacer, deployerCtx[varName].toString())
    }
    return inputString;
}


/**
 * Downloads a file to a target path using streams
 */
const validatorDownloadFile = (options) => {
    return (
        typeof options.url == 'string' &&
        isPathValid(options.path)
    )
}
const taskDownloadFile = async (options, basePath, deployerCtx) => {
    if(!validatorDownloadFile(options)) throw new Error(`invalid options`);
    if(options.path.endsWith('/')) throw new Error(`target filename not specified`); //FIXME: this should be on the validator

    //Process and create target file/path
    const destPath = safePath(basePath, options.path);
    await fs.outputFile(destPath, 'file save attempt, please ignore or remove');

    //Start file download and create write stream
    const res = await axios({
        method: 'get',
        url: options.url,
        responseType: 'stream'
    });
    await new Promise((resolve, reject) => {
        const outStream = fs.createWriteStream(destPath);
        res.data.pipe(outStream)
        outStream.on("finish", resolve);
        outStream.on("error", reject); // don't forget this!
    });
}


/**
 * Downloads a github repository with an optional reference (branch, tag, commit hash) or subpath. 
 * If the directory structure does not exist, it is created.
 */
const githubRepoSourceRegex = /^((https?:\/\/github\.com\/)?|@)?([\w\.\-_]+)\/([\w\.\-_]+).*$/;
const validatorDownloadGithub = (options) => {
    return (
        typeof options.src == 'string' &&
        isPathValid(options.dest, false) &&
        (typeof options.ref == 'string' || typeof options.ref == 'undefined') &&
        (typeof options.subpath == 'string' || typeof options.subpath == 'undefined')
    )
}
const taskDownloadGithub = async (options, basePath, deployerCtx) => {
    if(!validatorDownloadGithub(options)) throw new Error(`invalid options`);

    //Preparing vars
    const srcMatch = options.src.match(githubRepoSourceRegex);
    if(!srcMatch || !srcMatch[3] || !srcMatch[4]) throw new Error(`invalid repository`);
    const repoOwner = srcMatch[3];
    const repoName = srcMatch[4];
    const reference = options.ref || 'master';
    const downURL = `https://api.github.com/repos/${repoOwner}/${repoName}/zipball/${reference}`;
    const tmpFileName = `${repoName}${reference}-` + (Date.now()%100000000).toString(16);
    const tmpFileDir = path.join(basePath, `${tmpFileName}`);
    const tmpFilePath = path.join(basePath, `${tmpFileName}.download`);
    const destPath = safePath(basePath, options.dest);
    
    //Downloading file
    const res = await axios({
        method: 'get',
        url: downURL,
        responseType: 'stream'
    });
    await new Promise((resolve, reject) => {
        const outStream = fs.createWriteStream(tmpFilePath);
        res.data.pipe(outStream)
        outStream.on("finish", resolve);
        outStream.on("error", reject); // don't forget this!
    });

    //Extracting file
    const zip = new AdmZip(tmpFilePath);
    const zipEntries = zip.getEntries();
    if(!zipEntries.length || !zipEntries[0].isDirectory) throw new Error(`unexpected zip structure`);
    const extract = util.promisify(zip.extractAllToAsync);
    await extract(tmpFileDir, true);

    //Moving path
    const moveSrc = path.join(tmpFileDir, zipEntries[0].entryName, options.subpath || '');
    await fs.move(moveSrc, destPath, {
        overwrite: (options.overwrite === 'true' || options.overwrite === true)
    });

    //Removing temp paths
    await fs.remove(tmpFilePath);
    await fs.remove(tmpFileDir);
}


/**
 * Removes a file or directory. The directory can have contents. If the path does not exist, silently does nothing.
 */
const validatorRemovePath = (options) => {
    return (
        isPathValid(options.path, false)
    )
}
const taskRemovePath = async (options, basePath, deployerCtx) => {
    if(!validatorRemovePath(options)) throw new Error(`invalid options`);

    //Process and create target file/path
    const targetPath = safePath(basePath, options.path);

    //NOTE: being extra safe about not deleting itself
    const cleanBasePath = pathCleanTrail(path.normalize(basePath));
    if(cleanBasePath == targetPath) throw new Error(`cannot remove base folder`);
    await fs.remove(targetPath);
}


/**
 * Ensures that the directory exists. If the directory structure does not exist, it is created.
 */
const validatorEnsureDir = (options) => {
    return (
        isPathValid(options.path, false)
    )
}
const taskEnsureDir = async (options, basePath, deployerCtx) => {
    if(!validatorEnsureDir(options)) throw new Error(`invalid options`);

    //Process and create target file/path
    const destPath = safePath(basePath, options.path);
    await fs.ensureDir(destPath);
}


/**
 * Extracts a ZIP file to a targt folder.
 * NOTE: wow that was not easy to pick a library!
 *          - extract-zip: throws deprecation warnings
 *          - decompress: super super super slow!
 *          - adm-zip: bad docs, not promise-native, full of issues on github
 *          - tar << não abre zip
 *          - unzipper << não testei ainda
 */
const validatorUnzip = (options) => {
    return (
        isPathValid(options.src, false) &&
        isPathValid(options.dest)
    )
}
const taskUnzip = async (options, basePath, deployerCtx) => {
    if(!validatorUnzip(options)) throw new Error(`invalid options`);

    const srcPath = safePath(basePath, options.src);
    //maybe ensure dest doesn't seem to be an issue?
    const destPath = safePath(basePath, options.dest);

    const zip = new AdmZip(srcPath);
    const extract = util.promisify(zip.extractAllToAsync);
    await extract(destPath, true);
}


/**
 * Moves a file or directory. The directory can have contents.
 */
const validatorMovePath = (options) => {
    return (
        isPathValid(options.src, false) &&
        isPathValid(options.dest, false)
    )
}
const taskMovePath = async (options, basePath, deployerCtx) => {
    if(!validatorMovePath(options)) throw new Error(`invalid options`);

    const srcPath = safePath(basePath, options.src);
    const destPath = safePath(basePath, options.dest);
    await fs.move(srcPath, destPath, {
        overwrite: (options.overwrite === 'true' || options.overwrite === true)
    });
}


/**
 * Copy a file or directory. The directory can have contents.
 * TODO: add a filter property and use a glob lib in the fs.copy filter function
 */
const validatorCopyPath = (options) => {
    return (
        isPathValid(options.src) &&
        isPathValid(options.dest)
    )
}
const taskCopyPath = async (options, basePath, deployerCtx) => {
    if(!validatorCopyPath(options)) throw new Error(`invalid options`);

    const srcPath = safePath(basePath, options.src);
    const destPath = safePath(basePath, options.dest);
    await fs.copy(srcPath, destPath, {
        overwrite: (typeof options.overwrite !== 'undefined' && (options.overwrite === 'true' || options.overwrite === true))
    });
}


/**
 * Writes or appends data to a file. If not in the append mode, the file will be overwritten and the directory structure will be created if it doesn't exists.
 */
const validatorWriteFile = (options) => {
    return (
        typeof options.data == 'string' &&
        options.data.length &&
        isPathValid(options.file, false)
    )
}
const taskWriteFile = async (options, basePath, deployerCtx) => {
    if(!validatorWriteFile(options)) throw new Error(`invalid options`);

    const filePath = safePath(basePath, options.file);
    if(options.append === 'true' || options.append === true){
        await fs.appendFile(filePath, options.data);
    }else{
        await fs.outputFile(filePath, options.data);
    }
}


/**
 * Replaces a string in the target file or files array based on a search string.
 * Modes:
 *  - template: (default) target string will be processed for vars
 *  - literal: normal string search/replace without any vars
 *  - all_vars: all vars.toString() will be replaced. The search option will be ignored
 */
const validatorReplaceString = (options) => {
    //Validate file
    const fileList = (Array.isArray(options.file))? options.file : [options.file];
    if(fileList.some(s => !isPathValid(s, false))){
        return false;
    }

    //Validate mode
    if(
        typeof options.mode == 'undefined' ||
        options.mode == 'template' ||
        options.mode == 'literal'
    ){
        return (
            typeof options.search == 'string' &&
            options.search.length &&
            typeof options.replace == 'string'
        )

    }else if(options.mode == 'all_vars'){
        return true

    }else{

        return false;
    }
}
const taskReplaceString = async (options, basePath, deployerCtx) => {
    if(!validatorReplaceString(options)) throw new Error(`invalid options`);

    const fileList = (Array.isArray(options.file))? options.file : [options.file];
    for (let i = 0; i < fileList.length; i++){
        const filePath = safePath(basePath, fileList[i]);
        const original = await fs.readFile(filePath, 'utf8');
        let changed;
        if(typeof options.mode == 'undefined' || options.mode == 'template'){
            changed = original.replace(new RegExp(options.search, 'g'), replaceVars(options.replace, deployerCtx));
            
        }else if(options.mode == 'all_vars'){
            changed = replaceVars(original, deployerCtx);

        }else if(options.mode == 'literal'){
            changed = original.replace(new RegExp(options.search, 'g'), options.replace);
            
        }
        await fs.writeFile(filePath, changed);
    }
}


/**
 * Connects to a MySQL/MariaDB server and creates a database if the dbName variable is null.
 */
const validatorConnectDatabase = (options) => {
    return true;
}
const taskConnectDatabase = async (options, basePath, deployerCtx) => {
    if(!validatorConnectDatabase(options)) throw new Error(`invalid options`);
    if(typeof deployerCtx.dbHost !== 'string') throw new Error(`invalid dbHost`);
    if(typeof deployerCtx.dbUsername !== 'string') throw new Error(`invalid dbUsername`);
    if(typeof deployerCtx.dbPassword !== 'string') throw new Error(`dbPassword should be a string`);
    if(typeof deployerCtx.dbName !== 'string') throw new Error(`dbName should be a string`);
    if(typeof deployerCtx.dbDelete !== 'boolean') throw new Error(`dbDelete should be a boolean`);

    //Connect to the database
    const mysqlOptions = {
        host: deployerCtx.dbHost,
        user: deployerCtx.dbUsername,
        password: deployerCtx.dbPassword,
        multipleStatements: true,
    }
    deployerCtx.dbConnection = await mysql.createConnection(mysqlOptions);
    const escapedDBName = mysql.escapeId(deployerCtx.dbName);
    if(deployerCtx.dbDelete){
        await deployerCtx.dbConnection.query(`DROP DATABASE IF EXISTS ${escapedDBName}`);
    }
    await deployerCtx.dbConnection.query(`CREATE DATABASE IF NOT EXISTS ${escapedDBName} CHARACTER SET utf8 COLLATE utf8_general_ci`);
    await deployerCtx.dbConnection.query(`USE ${escapedDBName}`);
}


/**
 * Runs a SQL query in the previously connected database. This query can be a file path or a string.
 */
const validatorQueryDatabase = (options) => {
    if(typeof options.file !== 'undefined' && typeof options.query !== 'undefined') return false;
    if(typeof options.file == 'string') return isPathValid(options.file, false);
    if(typeof options.query == 'string') return options.query.length;
    return false;
}
const taskQueryDatabase = async (options, basePath, deployerCtx) => {
    if(!validatorQueryDatabase(options)) throw new Error(`invalid options`);
    if(!deployerCtx.dbConnection) throw new Error(`Database connection not found. Run connect_database before query_database`);

    let sql;
    if(options.file){
        const filePath = safePath(basePath, options.file);
        sql = await fs.readFile(filePath, 'utf8');
    }else{
        sql = options.query;
    }
    await deployerCtx.dbConnection.query(sql);
}


/**
 * Loads variables from a json file to the context.
 */
const validatorLoadVars = (options) => {
    return isPathValid(options.src, false)
}
const taskLoadVars = async (options, basePath, deployerCtx) => {
    if(!validatorLoadVars(options)) throw new Error(`invalid options`);
    
    const srcPath = safePath(basePath, options.src);
    const rawData = await fs.readFile(srcPath, 'utf8');
    const inData = JSON.parse(rawData);
    inData.dbConnection = undefined;
    Object.assign(deployerCtx, inData);
}


/**
 * DEBUG Just wastes time /shrug
 */
const validatorWasteTime = (options) => {
    return (typeof options.seconds == 'number')
}
const taskWasteTime = (options, basePath, deployerCtx) => {
    return new Promise((resolve, reject) => {
        setTimeout(() => {
            resolve(true)
        }, options.seconds * 1000);
    })
}


/**
 * DEBUG Fail fail fail :o
 */
const taskFailTest = async (options, basePath, deployerCtx) => {
    throw new Error(`test error :p`);
}


/**
 * DEBUG logs all ctx vars
 */
const taskDumpVars = async (options, basePath, deployerCtx) => {
    const toDump = cloneDeep(deployerCtx)
    toDump.dbConnection = (toDump.dbConnection && toDump.dbConnection.constructor && toDump.dbConnection.constructor.name)? toDump.dbConnection.constructor.name : undefined;
    dir(toDump)
}


/*
DONE:
    - waste_time (DEBUG)
    - fail_test (DEBUG)
    - dump_vars (DEBUG)
    - download_file
    - remove_path (file or folder)
    - ensure_dir
    - unzip
    - move_path (file or folder)
    - copy_path (file or folder)
    - write_file (with option to append only)
    - replace_string (single or array)
    - connect_database (connects to mysql, creates db if not set)
    - query_database (file or string)
    - download_github (with ref and subpath) 
    - load_vars
    
TODO:
    - ??????
*/


//Exports
module.exports = {
    download_file:{
        validate: validatorDownloadFile,
        run: taskDownloadFile,
    },
    download_github:{
        validate: validatorDownloadGithub,
        run: taskDownloadGithub,
    },
    remove_path:{
        validate: validatorRemovePath,
        run: taskRemovePath,
    },
    ensure_dir:{
        validate: validatorEnsureDir,
        run: taskEnsureDir,
    },
    unzip:{
        validate: validatorUnzip,
        run: taskUnzip,
    },
    move_path:{
        validate: validatorMovePath,
        run: taskMovePath,
    },
    copy_path:{
        validate: validatorCopyPath,
        run: taskCopyPath,
    },
    write_file:{
        validate: validatorWriteFile,
        run: taskWriteFile,
    },
    replace_string:{
        validate: validatorReplaceString,
        run: taskReplaceString,
    },
    connect_database:{
        validate: validatorConnectDatabase,
        run: taskConnectDatabase,
    },
    query_database:{
        validate: validatorQueryDatabase,
        run: taskQueryDatabase,
    },
    load_vars: {
        validate: validatorLoadVars,
        run: taskLoadVars,
    },

    //DEBUG mock only
    waste_time:{
        validate: validatorWasteTime,
        run: taskWasteTime,
    },
    fail_test:{
        validate: (() => true),
        run: taskFailTest,
    },
    dump_vars:{
        validate: (() => true),
        run: taskDumpVars,
    },
}