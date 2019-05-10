"use strict";

//    _______  ______ ___  ____  ____ _____ _(_)___  ____ _
//   / ___/ / / / __ `__ \/ __ \/ __ `/ __ `/ / __ \/ __ `/
//  (__  ) /_/ / / / / / / /_/ / /_/ / /_/ / / / / / /_/ / 
// /____/\__, /_/ /_/ /_/ .___/\__,_/\__, /_/_/ /_/\__, /  
//      /____/         /_/          /____/        /____/  

const axios = require('axios');
const { ConcurrencyManager } = require('axios-concurrency');
const axiosRetry = require('axios-retry');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const xmlbuilder = require('xmlbuilder');
const moment = require('moment');
const fs = require('fs');
const tmp = require('tmp');

const config = require('./config.json');

const ILSWS_BASE_URI = `https://${config.ILSWS_HOSTNAME}:${config.ILSWS_PORT}/${config.ILSWS_WEBAPP}/`;
const ILSWS_ORIGINATING_APP_ID = 'sympaging';
const MAX_CONCURRENT_REQUESTS = 2;

const api = axios.create({
  baseURL: ILSWS_BASE_URI,
  timeout: 600000,
  headers: {
    'sd-originating-app-id': ILSWS_ORIGINATING_APP_ID,
    'x-sirs-clientID': config.ILSWS_CLIENTID,
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  }
});

let reqCount = 0, itemCount = 0, errorCount = 0;
const isError = (obj) => obj instanceof Error && ++errorCount;

api.interceptors.request.use(req => {
  reqCount++;
  return req;
});

axiosRetry(api, { retries: 3, retryDelay: axiosRetry.exponetialDelay });

const manager = ConcurrencyManager(api, MAX_CONCURRENT_REQUESTS);

const ILSWS = {
  loginUser: (username, password) => api.post(`rest/security/loginUser`, {}, { params: { login: username, password: password }}),
  holdItemPullList: (token, branch) => {
    return api.get(`circulation/holdItemPullList/key/${branch}`, {
      params: {
        includeFields: 'pullList{holdRecord{holdType,status},item{call{bib{title,author,titleControlNumber},callNumber,volumetric},barcode,currentLocation{description}}}'
      },
      headers: { 'x-sirs-sessionToken': token }});
  }
};

const holdTypes = [
  { id: 'COPY', csvSuffix: 'Title', htmlSuffix: 'title', xslConfigOption: 'XSL_TITLE' },
  { id: 'TITLE', csvSuffix: 'Items', htmlSuffix: 'item', xslConfigOption: 'XSL_ITEM' }
];

function writeCsv(branch, records) {
  const csvHeader = [
    { id: 'barcode', title: 'BARCODE' },
    { id: 'title', title: 'TITLE' },
    { id: 'author', title: 'AUTHOR' },
    { id: 'callNumber', title: 'CALL #' },
    { id: 'volume', title: 'VOLUME' },
    { id: 'currentLocation', title: 'LOCATION' }
  ];

  holdTypes.forEach(holdType => {
    createCsvWriter({
      path: `/tmp/${config.BRANCHES[branch]}_${holdType.csvSuffix}.csv`,
      header: csvHeader
    }).writeRecords(records.filter(record => record.holdType === holdType.id));
  });
}

function writeHtml(branch, records) {
  let root;
  let tmpXmlFile;
  let htmlFile;

  holdTypes.forEach(holdType => {
    htmlFile = `${config.HTML_OUTPUT_DIR}/${config.BRANCHES[branch]}/latest_${holdType.htmlSuffix}.html`;
    try { fs.unlinkSync(htmlFile); } catch (e) {}

    const holdItems = records.filter(record => record.holdType === holdType.id);
    
    if (holdItems.length > 0) {
      root = xmlbuilder.create('paging_list', {
        'version': '1.0',
        'encoding': 'UTF-8'
      }).att('count', holdItems.length).att('location', config.BRANCHES[branch]).att('timestamp', moment().utcOffset(-8).toISOString(true));

      holdItems.forEach(record => {
        root.ele({
          'record': {
            'location': record.currentLocation,
            'loc_desc': record.locationDesc,
            'title': record.title,
            'call_number': record.callNumber,
            'barcode': record.barcode,
            'author': record.author
          }
        });
      });

      tmpXmlFile  = tmp.fileSync();
      fs.writeFileSync(tmpXmlFile.name, root.end());
    
      require('child_process').execSync(`xsltproc ${config[holdType.xslConfigOption]} ${tmpXmlFile.name} > ${htmlFile}`);

      tmpXmlFile.removeCallback();
    } else {
      fs.symlinkSync(`${config.HTML_OUTPUT_DIR}/no_${holdType.htmlSuffix}_list.html`, htmlFile);
    }
  });
}

function processBranch(branch) {
  let records = [];

  return ILSWS.loginUser(config.ILSWS_USERNAME, config.ILSWS_PASSWORD)
  .then(loginResponse => {
     if (isError(loginResponse)) throw loginResponse;

     return loginResponse.data;
   })
  .then(loginData => ILSWS.holdItemPullList(loginData.sessionToken, branch))
  .then(pullListResponse => {
    if (isError(pullListResponse)) throw pullListResponse;
    return pullListResponse.data;
  })
  .then(pullListData => {
    pullListData.fields.pullList.filter(record => record.fields.holdRecord.fields.status !== 'EXPIRED').map(({fields}) => {
      records.push({
        barcode: fields.item.fields.barcode,
        title: fields.item.fields.call.fields.bib.fields.title,
        author:  fields.item.fields.call.fields.bib.fields.author,
        callNumber: fields.item.fields.call.fields.callNumber,
        volume: fields.item.fields.call.fields.volumetric || '',
        bib: fields.item.fields.call.fields.bib.fields.titleControlNumber,
        holdType: fields.holdRecord.fields.holdType,
        currentLocation: fields.item.fields.currentLocation.key,
        locationDesc: fields.item.fields.currentLocation.fields.description
      });
    });

    itemCount += records.length;

    records.sort((a,b) => config.SORT_ORDER.map(f => a[f].localeCompare(b[f])).find(e => e !== 0));
        
    writeCsv(branch, records);
    writeHtml(branch, records);
  });
}

async function start() {
  for (let branch of Object.keys(config.BRANCHES)) {
    let start = new Date();
    try {
      await processBranch(branch);
    } catch (error) {
      console.log(error);
      process.exit(1);
    }
    console.log(`${branch}: ${new Date() - start}ms`);
  }

  console.log(`${MAX_CONCURRENT_REQUESTS}, ${errorCount}, ${itemCount}, ${reqCount}`);
}

start();

process.on('exit', manager.detach);
