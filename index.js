'use strict';

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

function writeCsv(branch, records) {
  const titles = records.filter(record => record.holdType === 'COPY');
  const items = records.filter(record => record.holdType === 'TITLE');
  const csvHeader = [
    { id: 'barcode', title: 'BARCODE' },
    { id: 'title', title: 'TITLE' },
    { id: 'author', title: 'AUTHOR' },
    { id: 'callNumber', title: 'CALL #' },
    { id: 'volume', title: 'VOLUME' },
    { id: 'currentLocation', title: 'LOCATION' }
  ];

  let csvWriter = createCsvWriter({
    path: `/tmp/${config.BRANCHES[branch]}_Title.csv`,
    header: csvHeader
  });

    csvWriter.writeRecords(titles);
  
  csvWriter = createCsvWriter({
    path: `/tmp/${config.BRANCHES[branch]}_Items.csv`,
    header: csvHeader
  });

  csvWriter.writeRecords(items);
}

function writeXml(branch, records) {
  const titles = records.filter(record => record.holdType === 'COPY');
  const items = records.filter(record => record.holdType === 'TITLE');
  const itemHtml = `${config.HTML_OUTPUT_DIR}/${config.BRANCHES[branch]}/latest_item.html`;
  const titleHtml = `${config.HTML_OUTPUT_DIR}/${config.BRANCHES[branch]}/latest_title.html`;

  let root;
  let tmpxmlfile;

  try {
    fs.unlinkSync(itemHtml);
    fs.unlinkSync(titleHtml);
  } catch (e) {}

  if (titles.length > 0) {
    root = xmlbuilder.create('paging_list', {
      'version': '1.0',
      'encoding': 'UTF-8'
    }).att('count', titles.length).att('location', config.BRANCHES[branch]).att('timestamp', moment().utcOffset(-8).toISOString(true));

    for (let record of titles) {
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
    }
    
    tmpxmlfile  = tmp.fileSync();
    fs.writeFileSync(tmpxmlfile.name, root.end());

    require('child_process').execSync(`xsltproc ${config.XSL_TITLE} ${tmpxmlfile.name} > ${titleHtml}`);

    tmpxmlfile.removeCallback();
  } else {
    try { fs.unlinkSync(titleHtml); } catch (e) {}
    fs.symlinkSync(`${config.HTML_OUTPUT_DIR}/no_title_list.html`, titleHtml);
  }

  if (items.length > 0) { 
    root = xmlbuilder.create('paging_list', {
      'version': '1.0',
      'encoding': 'UTF-8'
    }).att('count', items.length).att('location', config.BRANCHES[branch]).att('timestamp', moment().utcOffset(-8).toISOString(true));

    for (let record of items) {
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
    }

    tmpxmlfile = tmp.fileSync();
    fs.writeFileSync(tmpxmlfile.name, root.end());

    require('child_process').execSync(`xsltproc ${config.XSL_ITEM} ${tmpxmlfile.name} > ${itemHtml}`);

    tmpxmlfile.removeCallback();
  } else {
    try { fs.unlinkSync(itemHtml); } catch (e) {}
    fs.symlinkSync(`${config.HTML_OUTPUT_DIR}/no_item_list.html`, itemHtml);
  }
}

function processBranch(branch) {
  let records = [];

  return ILSWS.loginUser(config.ILSWS_USERNAME, config.ILSWS_PASSWORD)
  .then(loginResponse => {
     if (isError(loginResponse)) throw loginResponse;

     return loginResponse.data;
   })
  .then(loginData => Promise.all([loginData, ILSWS.holdItemPullList(loginData.sessionToken, branch)]))
  .then(([loginData, pullListResponse]) => Promise.all([loginData, pullListResponse.data])) 
  .then(([loginData, pullListData]) => {
    if (isError(pullListData)) return;

    pullListData.fields.pullList.filter(record => record.fields.holdRecord.fields.status !== 'EXPIRED').map(record => {
      records.push({
        barcode: record.fields.item.fields.barcode,
        title: record.fields.item.fields.call.fields.bib.fields.title, 
        author:  record.fields.item.fields.call.fields.bib.fields.author,
        callNumber: record.fields.item.fields.call.fields.callNumber,
        volume: record.fields.item.fields.call.fields.volumetric || '',
        bib: record.fields.item.fields.call.fields.bib.fields.titleControlNumber,
        holdType: record.fields.holdRecord.fields.holdType,
        currentLocation: record.fields.item.fields.currentLocation.key,
        locationDesc: record.fields.item.fields.currentLocation.fields.description
      });
    });

    itemCount += records.length;

    records.sort((a,b) => config.SORT_ORDER.map(f => a[f].localeCompare(b[f])).find(e => e !== 0));
        
    writeCsv(branch, records);
    writeXml(branch, records);
  });
}

async function start() {
  for (let branch of Object.keys(config.BRANCHES)) {
    let start = new Date();
    try {
      await processBranch(branch);
    } catch (error) {
      console.log(error);
      console.log(error.toString());
      process.exit(1);
    }
    console.log(`${branch}: ${new Date() - start}ms`);
  }

  console.log(`${MAX_CONCURRENT_REQUESTS}, ${errorCount}, ${itemCount}, ${reqCount}`);
}

start();
