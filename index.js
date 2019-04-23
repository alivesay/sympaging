'use strict';

const axios = require('axios');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const xmlbuilder = require('xmlbuilder');
const moment = require('moment');
const fs = require('fs');
const tmp = require('tmp');

const config = require('./config.json');

const ILSWS_BASE_URI = `https://${config.ILSWS_HOSTNAME}:${config.ILSWS_PORT}/${config.ILSWS_WEBAPP}`;
const ILSWS_ORIGINATING_APP_ID = 'sympaging';

axios.defaults.headers.common['sd-originating-app-id'] = ILSWS_ORIGINATING_APP_ID;
axios.defaults.headers.common['x-sirs-clientID'] = config.ILSWS_CLIENTID;
axios.defaults.headers.common['Accept'] = 'application/json';
axios.defaults.headers.common['Content-Type'] = 'application/json';
axios.defaults.timeout = 10000;

axios.interceptors.request.use(req => {
  console.log(req.url);
  return req;
});

function ILSWSRequest_loginUser(username, password) {
  return axios({
    method: 'POST',
    url: `${ILSWS_BASE_URI}/rest/security/loginUser`,
    params: {
      login: username,
      password: password
    }
  });
}

function ILSWSRequest_holdItemPullList(token, branch) {
  return axios({
    method: 'GET',
    url: `${ILSWS_BASE_URI}/circulation/holdItemPullList/key/${branch}?includeFields=pullList{*,hold{*}}`,
    headers: {
      'x-sirs-sessionToken': token
    }
  });
}

function ILSWSRequest_holdRecord(token, key) {
  return axios({
    method: 'GET',
    url: `${ILSWS_BASE_URI}/circulation/holdRecord/key/${key}`,
    headers: {
      'x-sirs-sessionToken': token
    }
  });
}

function ILSWSRequest_bib(token, key) {
  return axios({
    method: 'GET',
    url: `${ILSWS_BASE_URI}/catalog/bib/key/${key}`,
    headers: {
      'x-sirs-sessionToken': token
    }
  });
}

function ILSWSRequest_call(token, key) {
  return axios({
    method: 'GET',
    url: `${ILSWS_BASE_URI}/catalog/call/key/${key}`,
    headers: {
      'x-sirs-sessionToken': token
    }
  });
}

function ILSWSRequest_item(token, key) {
  return axios({
    method: 'GET',
    url: `${ILSWS_BASE_URI}/catalog/item/key/${key}`,
    headers: {
      'x-sirs-sessionToken': token
    }
  });
}

function ILSWSRequest_patron(token, key) {
  return axios({
    method: 'GET',
    url: `${ILSWS_BASE_URI}/user/patron/key/${key}`,
    headers: {
      'x-sirs-sessionToken': token
    }
  });
}

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

async function start(branch) {
  let records = [];

  await ILSWSRequest_loginUser(config.ILSWS_USERNAME, config.ILSWS_PASSWORD)
  .then(loginResponse => loginResponse.data)
  .then(loginData => Promise.all([loginData, ILSWSRequest_holdItemPullList(loginData.sessionToken, branch)]))
  .then(([loginData, pullListResponse]) => Promise.all([loginData, pullListResponse.data]))
  .then(([loginData, pullListData]) => {
    return axios.all(pullListData.fields.pullList.map(record => {
      return Promise.all([ILSWSRequest_holdRecord(loginData.sessionToken, record.fields.holdRecord.key),
        ILSWSRequest_item(loginData.sessionToken, record.fields.item.key)]);
    }))
    .then(axios.spread(function ( ...holdItems) {
      return axios.all(holdItems.map(holdItem => {
        return Promise.all([ILSWSRequest_patron(loginData.sessionToken, holdItem[0].data.fields.patron.key),
          ILSWSRequest_bib(loginData.sessionToken, holdItem[0].data.fields.bib.key),
          ILSWSRequest_call(loginData.sessionToken, holdItem[1].data.fields.call.key),
          {
            holdType: holdItem[0].data.fields.holdType,
            status: holdItem[0].data.fields.status,
            currentLocation: holdItem[1].data.fields.currentLocation.key
          }]);
      }))
      .then(axios.spread(function ( ...patronBibCall) {
        for (let x of patronBibCall) {
          records.push({
            barcode: x[1].data.fields.barcode,
            title:   x[1].data.fields.title,
            author:  x[1].data.fields.author,
            callNumber: x[2].data.fields.callNumber,
            volume: x[2].data.fields.volumetric || '',
            bib: x[1].data.fields.titleControlNumber,
            holdType: x[3].holdType,
            currentLocation: x[3].currentLocation
          });
        }

        writeCsv(branch, records);
	writeXml(branch, records);
      }))
    }));
  })
  .catch(error => {
    console.log(error.toString());
    return Promise.reject();
  });
  
}

async function process() {
  for (let branch in config.BRANCHES) {
     await start(branch);
  }
}

process();
