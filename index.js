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
const MAX_CONCURRENT_REQUESTS = 5;

const api = axios.create({
  baseURL: ILSWS_BASE_URI,
  timeout: 3000,
  headers: {
    'sd-originating-app-id': ILSWS_ORIGINATING_APP_ID,
    'x-sirs-clientID': config.ILSWS_CLIENTID,
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  }
});

let reqCount = 0, itemCount = 0;
api.interceptors.request.use(req => {
  reqCount++;
  return req;
});

axiosRetry(api, { retries: 3, retryDelay: axiosRetry.exponetialDelay });

const manager = ConcurrencyManager(api, MAX_CONCURRENT_REQUESTS);

const ILSWS = {
  loginUser: (username, password) => api.post(`rest/security/loginUser`, {}, { params: { login: username, password: password }}),
  holdItemPullList: (token, branch) => api.get(`circulation/holdItemPullList/key/${branch}`, { headers: { 'x-sirs-sessionToken': token }}),
  holdRecord: (token, key) => api.get(`circulation/holdRecord/key/${key}`, { headers: { 'x-sirs-sessionToken': token }}),
  bib: (token, key) => api.get(`catalog/bib/key/${key}`, { headers: { 'x-sirs-sessionToken': token }}),
  call: (token, key) => api.get(`catalog/call/key/${key}`, { headers: { 'x-sirs-sessionToken': token }}),
  item: (token, key) => api.get(`catalog/item/key/${key}`, { headers: { 'x-sirs-sessionToken': token }}),
  patron: (token, key) => api.get(`user/patron/key/${key}`, { headers: {'x-sirs-sessionToken': token }})
};

function writeCsv(branch, records) {
  let titles = records.filter(record => record.holdType === 'COPY' && record.status !== 'EXPIRED');
  let items = records.filter(record => record.holdType === 'TITLE' && record.status !== 'EXPIRED');

  let csvWriter = createCsvWriter({
    path: `/tmp/${config.BRANCHES[branch]}_Title.csv`,
    header: [
      { id: 'barcode', title: 'BARCODE' },
      { id: 'title', title: 'TITLE' },
      { id: 'author', title: 'AUTHOR' },
      { id: 'callNumber', title: 'CALL #' },
      { id: 'volume', title: 'VOLUME' },
      { id: 'currentLocation', title: 'LOCATION' }
    ]});

    csvWriter.writeRecords(titles);
  
  csvWriter = createCsvWriter({
    path: `/tmp/${config.BRANCHES[branch]}_Items.csv`,
    header: [
      { id: 'barcode', title: 'BARCODE' },
      { id: 'title', title: 'TITLE' },
      { id: 'author', title: 'AUTHOR' },
      { id: 'callNumber', title: 'CALL #' },
      { id: 'volume', title: 'VOLUME' },
      { id: 'currentLocation', title: 'LOCATION' }
    ]});

    csvWriter.writeRecords(items);
}

function writeXml(branch, records) {
  let titles = records.filter(record => record.holdType === 'COPY' && record.status !== 'EXPIRED');
  let items = records.filter(record => record.holdType === 'TITLE' && record.status !== 'EXPIRED');
  let itemHtml = `${config.HTML_OUTPUT_DIR}/${config.BRANCHES[branch]}/latest_item.html`;
  let titleHtml = `${config.HTML_OUTPUT_DIR}/${config.BRANCHES[branch]}/latest_title.html`;

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
          'location': branch,
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
          'location': branch,
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

let errorCount = 0;
const isError = (obj) => obj instanceof Error && ++errorCount;

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
    itemCount = pullListData.fields.pullList.length;
    
    return Promise.all(pullListData.fields.pullList.map(record => {
      return Promise.all([ILSWS.holdRecord(loginData.sessionToken, record.fields.holdRecord.key),
        ILSWS.item(loginData.sessionToken, record.fields.item.key)]);
    }))
    .then(axios.spread(function ( ...holdItems) {
      return axios.all(holdItems.map(holdItem => {
        if (holdItem.some(isError)) return;

        return Promise.all([ILSWS.patron(loginData.sessionToken, holdItem[0].data.fields.patron.key),
          ILSWS.bib(loginData.sessionToken, holdItem[0].data.fields.bib.key),
          ILSWS.call(loginData.sessionToken, holdItem[1].data.fields.call.key), {
            holdType: holdItem[0].data.fields.holdType,
            status: holdItem[0].data.fields.status,
            currentLocation: holdItem[1].data.fields.currentLocation.key
          }]);
      }))
      .then(axios.spread(function ( ...patronBibCallDetails) {

        for (let details of patronBibCallDetails) {
          if (!details || details.some(isError)) return;

          records.push({
            barcode: details[1].data.fields.barcode,
            title:   details[1].data.fields.title,
            author:  details[1].data.fields.author,
            callNumber: details[2].data.fields.callNumber,
            volume: details[2].data.fields.volumetric || '',
            bib: details[1].data.fields.titleControlNumber,
            holdType: details[3].holdType,
            currentLocation: details[3].currentLocation
          });
        }

        writeCsv(branch, records);
	writeXml(branch, records);
      }));
    }));
  });
}

async function start() {
  for (let branch of Object.keys(config.BRANCHES)) {
    let start = new Date();
    try {
      await processBranch(branch);
    } catch (error) {
      console.log(error.toString());
      process.exit(1);
    }
    console.log(`${branch}: ${new Date() - start}ms`);
  }

  console.log(`${MAX_CONCURRENT_REQUESTS}, ${errorCount}, ${itemCount}, ${reqCount}`);
}

start();
