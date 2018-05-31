/**
 * A comic configuration, from comics.json
 * @typedef {Object} ComicConfig
 * @property {String} name The name of the comic
 * @property {String} firstPageUrl URL of the first comic page
 * @property {String|Array.<String>} latestPageLink CSS selector pointing to the "latest page" link (or an array of CSS selectors)
 * @property {String} previousPageLink CSS selector pointing to the "previous page" link
 * @property {String} image CSS selector pointing either to the comic image or to a link to the image
 * @property {?String} altImage Optional CSS selector for an alternate image, this takes precedence over image
 * @property {Boolean} titleText Whether the comic has (meaningful) title texts
 * @property {?String} commentary CSS selector pointing to the commentary (null if there is no commentary)
 * @property {?Array.<String>} pageDate Array with two strings and an optional boolean (null if there is no date): First a CSS selector pointing to the page date, second the format of the date; a truthy value as the third element means strict parsing should NOT be used
 * @property {?String} pageTitle CSS selector pointing to the page title (null if there is no title)
 */

/**
 * A comic page
 * @typedef {Object} Page The page that should be saved
 * @property {String} image URL of the image of the page
 * @property {String} pageUrl URL of the page
 * @property {?String} pageDate Date of the page
 * @property {?String} pageTitle Title of the page
 * @property {?String} titleText Title text of the image
 * @property {?String} commentary Commentary / Author's Notes for the image
 */

const cheerio = require('cheerio');
const fileType = require('file-type');
const moment = require('moment');
const sanitize = require('sanitize-filename');
const TurndownService = require('turndown');

const fs = require('fs');
const http = require('follow-redirects').http;
const https = require('follow-redirects').https;
const path = require('path');
const readline = require('readline');
const Transform = require('stream').Transform;

const turndownService = new TurndownService({
	hr: '- - -',
	codeBlockStyle: 'fenced',
	fence: '```',
});
turndownService.addRule('no-img', {
	filter: 'img',
	replacement: () => '',
});
turndownService.addRule('underline', {
	filter: 'u',
	replacement: (content) => `__${content}__`,
});

// if __dirname === current working dir, then outPath = ./comics, else outPath = .
let outPath;
if (path.relative(__dirname, '.').length === 0) {
	outPath = path.join('.', 'comics');
} else {
	outPath = path.join('.');
}

if (!dirExists(outPath)) {
	fs.mkdirSync(outPath);
}

let comics;
if (fileExists(path.join(outPath, 'comics.json'))) {
	const comicsText = fs.readFileSync(path.join(outPath, 'comics.json'), 'utf8');
	comics = JSON.parse(comicsText);
} else if (fileExists(path.join(__dirname, 'comics.json'))) {
	const comicsText = fs.readFileSync(path.join(__dirname, 'comics.json'), 'utf8');
	comics = JSON.parse(comicsText);
} else {
	throw new Error('No comics.json file found');
}

// hide invalid comic configurations
comics = comics.filter(e => validateComicConfig(e));

// make comics appear sorted by name
comics = comics.sort((a, b) => {
	if (a.name < b.name) {
		return -1;
	} else if (a.name > b.name) {
		return 1;
	}
	return 0;
});

if (comics.length === 0) {
	console.log('No comics available');
	process.exit(0);
}

console.log('Available comics:');
console.log('0\tDOWNLOAD ALL');
for (let i = 0; i < comics.length; ++i) {
	console.log(`${i + 1}\t${comics[i].name}`);
}
console.log('Enter space-seperated numbers of all comics to download:');

getUserInput()
	.then(input => validateUserInput(input))
	.then(async validComicIds => {
		for (let i = 0; i < validComicIds.length; ++i) {
			const comic = comics[validComicIds[i]];
			console.log(`Updating comic "${comic.name}"`);
			drawProgress(null, null);
			try {
				const amountDownloaded = await updateComic(comic);
				console.log(`Downloaded ${amountDownloaded} new page${amountDownloaded === 1 ? '' : 's'}`);
			} catch (err) {
				process.removeAllListeners('SIGINT');
				console.error(`Error while updating comic "${comic.name}":`);
				console.error(err);
			}
		}
		process.exit(0);
	});

/**
 * Utility function to see if a directory exists
 * @param {String} dirPath Path to the directory
 * @returns {Boolean} Whether the directory exists
 */
function dirExists(dirPath) {
	try {
		const stats = fs.statSync(dirPath);
		return stats.isDirectory();
	} catch (e) {
		return false;
	}
}

/**
 * Prints a message without interfering with the comic update progress bar
 * @param {String|Array<String>} message The message(s) to print
 * @returns {void}
 */
function drawMessage(message) {
	const CPL = '\x1b[F'; // Cursor Previous Line
	const EL = '\x1b[K'; // Erase in Line

	const messageList = Array.isArray(message) ? message : [message];

	// move cursor up two lines so that the progress bar is overwritten
	process.stdout.write(CPL + CPL);

	for (const msg of messageList) {
		process.stdout.write(EL + msg + '\n');
	}

	drawProgress(null, null);
}

/**
 * Prints a well-formatted visualisation of the comic update progress
 * @param {?Number} downloaded How many new images have been downloaded, null if download hasn't started yet
 * @param {?Number} found How many new images have been found
 * @param {Boolean} firstCall Whether this is the first time this function is called for this comic
 * @returns {void}
 */
function drawProgress(downloaded, found) {
	// progress bar settings
	const BAR_LENGTH = 70;
	const INDETERMINATE_SEGMENT_LENGTH = 15;
	const INDETERMINATE_STRIPE_DISTANCE = 4;
	const INDETERMINATE_STRIPED = true;

	const CPL = '\x1b[F'; // Cursor Previous Line
	const EL = '\x1b[K'; // Erase in Line

	let firstLine, secondLine;

	if (downloaded === null && found === null) {
		// draw initial state progress bar
		firstLine = '0 new images found';
		secondLine = '[' + ' '.repeat(BAR_LENGTH) + ']';
		process.stdout.write(EL + firstLine + '\n' + EL + secondLine + '\n');
		return;
	}

	// move cursor back to the beginning, so that the previous progress bar will be overwritten
	process.stdout.write(CPL + CPL);

	if (downloaded === null) {
		firstLine = found + ' new images found';
		let progressBar;
		if (INDETERMINATE_STRIPED) {
			const barSegmentArray = ' '.repeat(INDETERMINATE_STRIPE_DISTANCE - 1).split('');
			barSegmentArray.splice(found % INDETERMINATE_STRIPE_DISTANCE, 0, '=');
			progressBar = barSegmentArray.join('').repeat(Math.ceil(BAR_LENGTH / INDETERMINATE_STRIPE_DISTANCE)).slice(0, BAR_LENGTH);
		} else {
			progressBar = ' '.repeat(BAR_LENGTH - INDETERMINATE_SEGMENT_LENGTH) + '='.repeat(INDETERMINATE_SEGMENT_LENGTH);
			progressBar = progressBar.slice(-(found % BAR_LENGTH)) + progressBar.slice(0, -(found % BAR_LENGTH));
		}
		secondLine = '[' + progressBar + ']';
	} else {
		if (downloaded === 0 && found === 0) {
			firstLine = `0 / 0 images downloaded`;
			secondLine = `[${'='.repeat(BAR_LENGTH)}]`;
		} else {
			const percentDownloaded = downloaded / found;
			const displayPercentDownloaded = String(Math.floor(percentDownloaded * 1000) / 10);
			const progress = Math.floor(BAR_LENGTH * percentDownloaded);
			firstLine = `${downloaded} / ${found} images downloaded (${displayPercentDownloaded}%)`;
			secondLine = `[${'='.repeat(progress)}${' '.repeat(BAR_LENGTH - progress)}]`;
		}
	}

	process.stdout.write(EL + firstLine + '\n' + EL + secondLine + '\n');
}

/**
 * Downloads a comic page and returns it as string
 * @param {String} pageUrl The url of the page to download
 * @returns {Promise.<String>} The HTML of the downloaded page
 */
async function fetchComicPage(pageUrl) {
	const pageContent = await httpRequest(pageUrl);
	return pageContent.toString();
}

/**
 * Utility function to see if a file exists
 * @param {String} filePath Path to the file
 * @returns {Boolean} Whether the file exists
 */
function fileExists(filePath) {
	try {
		const stats = fs.statSync(filePath);
		return stats.isFile();
	} catch (e) {
		return false;
	}
}

/**
 * Finds a link to the latest page of the comic
 * @param {ComicConfig} comicConfig The configuration of the comic
 * @returns {Promise.<String>} The link to the latest comic page
 */
async function findLatestPageUrl(comicConfig) {
	if (typeof comicConfig.latestPageLink === 'string') {
		const pageHtml = await fetchComicPage(comicConfig.firstPageUrl);
		const $ = cheerio.load(pageHtml);
		const latestPageUrl = $(comicConfig.latestPageLink).attr('href');
		if (!latestPageUrl) {
			throw new Error(`Link to latest page not found: "${comicConfig.latestPageLink}"`);
		}
		return resolveUrl(latestPageUrl, comicConfig.firstPageUrl);
	} else {
		let nextStepUrl = comicConfig.firstPageUrl;
		for (const nextStep of comicConfig.latestPageLink) {
			const pageHtml = await fetchComicPage(nextStepUrl);
			const $ = cheerio.load(pageHtml);
			nextStepUrl = $(nextStep).attr('href');
			if (!nextStepUrl) {
				throw new Error(`Link to latest page not found: "${nextStep}"`);
			}
			nextStepUrl = resolveUrl(nextStepUrl, comicConfig.firstPageUrl);
		}
		return nextStepUrl;
	}
}

/**
 * Reads user input from stdin and returns it
 * @returns {Promise.<String>} User input
 */
function getUserInput() {
	return new Promise((resolve, reject) => {
		const rl = readline.createInterface({
			input: process.stdin,
		});

		rl.on('line', line => {
			rl.close();
			resolve(line);
		});
	});
}

/**
 * Executes a HTTP request and returns a Buffer containing the response
 * @param {*} url The URL to make a request to
 * @returns {Promise.<Buffer>} The response to the request
 */
function httpRequest(url) {
	return new Promise((resolve, reject) => {
		let protocol;
		try {
			protocol = /^([a-z]+):\/\//.exec(url)[1];
		} catch (err) {
			throw new Error('Unsupported URL: ' + url);
		}
		let requestLib;
		if (protocol === 'http') {
			requestLib = http;
		} else if (protocol === 'https') {
			requestLib = https;
		} else {
			reject(new Error('Unsupported protocol: ' + protocol));
			return;
		}
		const request = requestLib.request(url, response => {
			const responseData = new Transform();
			response.on('data', data => {
				responseData.push(data);
			});
			response.on('end', () => {
				resolve(responseData.read());
			});
		});
		request.end();
		request.on('error', err => {
			reject(err);
		});
	});
}

/**
 * Reads array of already downloaded pages from disk
 * @param {String} comicName The name of the comic
 * @returns {Array.<String>} Array with the titles of all already downloaded pages
 */
function loadExistingPages(comicName) {
	// create folder for comic if it doesn't exist
	if (!dirExists(path.join(outPath, comicName))) {
		fs.mkdirSync(path.join(outPath, comicName));
	}
	// create pages.json if it doesn't exist
	if (!fileExists(path.join(outPath, comicName, 'pages.json'))) {
		fs.writeFileSync(path.join(outPath, comicName, 'pages.json'), '[]');
	}
	// read pages.json
	const existingPagesString = fs.readFileSync(path.join(outPath, comicName, 'pages.json'), 'utf8');
	const existingPages = JSON.parse(existingPagesString);
	return existingPages;
}

/**
 * Resolves a URL to its proper absolute form
 * @param {String} url The URL to resolve
 * @param {String} firstPageUrl The URL to the first page of the comic, to use as base
 * @returns {String} The resolved URL
 */
function resolveUrl(url, firstPageUrl) {
	const baseUrl = new URL(firstPageUrl);
	const resolvedUrl = new URL(url, baseUrl.origin);
	return resolvedUrl.href;
}

/**
 * Saves array of already downloaded pages to disk
 * @param {String} comicName The name of the comic the pages belong to
 * @param {Array.<String>} existingPages Array with the titles of all downloaded pages
 * @returns {void}
 */
function saveExistingPages(comicName, existingPages) {
	const existingPagesString = JSON.stringify(existingPages, null, '\t');
	fs.writeFileSync(path.join(outPath, comicName, 'pages.json'), existingPagesString);
}

/**
 * Downloads an image and saves it to disk
 * @param {String} comicName The name of the comic the image belongs to
 * @param {Number} pageNumber The page number of the image
 * @param {Page} page The page that should be saved
 * @returns {Promise.<void>} Promise signalling that the save was successful
 */
async function saveImage(comicName, pageNumber, page) {
	let image;
	try {
		image = await httpRequest(page.image);
	} catch (err) {
		// Try one more time in case of temporary network issue
		console.error(`Error while downloading image ${page.image} on page ${page.pageUrl}; retrying`);
		try {
			image = await httpRequest(page.image);
		} catch (err2) {
			throw err2;
		}
	}

	// build image name
	let imageName = String(pageNumber).padStart(5, '0') + ' ';
	if (page.pageDate) {
		imageName += page.pageDate + ' ';
	}
	if (page.pageTitle) {
		imageName += page.pageTitle;
	} else {
		const url = new URL(page.pageUrl);
		imageName += url.pathname.slice(1) + url.search;
	}
	imageName = sanitize(imageName, {replacement: '_'});

	const extensionObj = fileType(image);
	let extensionString;
	if (extensionObj !== null) {
		extensionString = extensionObj.ext;
	} else {
		throw new Error('Could not determine file extension of ' + page.image + ' on page ' + page.pageUrl);
	}

	fs.writeFileSync(path.join(outPath, comicName, imageName + '.' + extensionString), image);

	// save title text if there is one
	if (page.titleText) {
		if (!dirExists(path.join(outPath, comicName, 'title texts'))) {
			fs.mkdirSync(path.join(outPath, comicName, 'title texts'));
		}
		fs.writeFileSync(path.join(outPath, comicName, 'title texts', imageName + ' Title Text.txt'), page.titleText);
	}

	// save commentary if there is one
	if (page.commentary) {
		if (!dirExists(path.join(outPath, comicName, 'commentaries'))) {
			fs.mkdirSync(path.join(outPath, comicName, 'commentaries'));
		}
		fs.writeFileSync(path.join(outPath, comicName, 'commentaries', imageName + ' Commentary.txt'), page.commentary);
	}

	return;
}

/**
 * Downloads all new pages of a comic
 * @param {ComicConfig} comicConfig The configuration of the comic
 * @returns {Promise.<Number>} How many new pages were downloaded
 */
async function updateComic(comicConfig) {
	let dateWarning = false;
	let interrupted = false;

	const existingPages = await loadExistingPages(comicConfig.name);
	const newPages = [];
	let lastSaved;
	if (existingPages.length) {
		lastSaved = existingPages[existingPages.length - 1];
	} else {
		lastSaved = null;
	}

	process.once('SIGINT', () => {
		// interrupted while searching for new pages
		interrupted = true;
		drawMessage('Interrupted by user...');
		drawProgress(null, newPages.length);
	});

	// get link for latest page
	let nextLinkToCheck = await findLatestPageUrl(comicConfig);
	if (!nextLinkToCheck) {
		throw new Error('Link to latest page not found');
	}
	// check pages until you get the last saved one
	for (;;) {
		if (interrupted) {
			return 0;
		}

		// check pages until you get the last saved one
		let pageHtml;
		try {
			pageHtml = await fetchComicPage(nextLinkToCheck);
		} catch (err) {
			// Try one more time in case of temporary network issue
			console.error(`Error while downloading page ${nextLinkToCheck}; retrying`);
			try {
				pageHtml = await fetchComicPage(nextLinkToCheck);
			} catch (err2) {
				// TODO save already found newPages
				throw err2;
			}
		}
		const $ = cheerio.load(pageHtml);

		/** @type {Page} */
		const pageObj = {
			pageUrl: nextLinkToCheck,
			pageTitle: comicConfig.pageTitle ? $(comicConfig.pageTitle).clone().children().remove().end().text().trim() : null,
			titleText: comicConfig.titleText ? ($(comicConfig.image).attr('title') || '').trim() : null,
		};
		// get image url
		let $image;
		if (comicConfig.altImage && $(comicConfig.altImage).get(0)) {
			$image = $(comicConfig.altImage);
		} else {
			$image = $(comicConfig.image);
		}
		if (!$image.get(0)) {
			throw new Error('Image not found: ' + pageObj.pageUrl);
		}
		let imageUrl;
		if ($image.get(0).tagName === 'img') {
			imageUrl = resolveUrl($image.attr('src'), comicConfig.firstPageUrl);
		} else if ($image.get(0).tagName === 'a') {
			imageUrl = resolveUrl($image.attr('href'), comicConfig.firstPageUrl);
		}
		pageObj.image = imageUrl;
		if (!pageObj.image) {
			throw new Error('Image not found: ' + pageObj.pageUrl);
		}
		// get and parse commentary
		if (comicConfig.commentary) {
			const commentaryHtml = $(comicConfig.commentary).html().trim();
			pageObj.commentary = turndownService.turndown(commentaryHtml).replace(/(?<!\r)\n/g, '\r\n');
		} else {
			pageObj.commentary = null;
		}
		// get date in YYYY-MM-DD format if possible
		if (comicConfig.pageDate) {
			let strictParsing = true;
			if (comicConfig.pageDate.length > 2 && comicConfig.pageDate[2]) {
				strictParsing = false;
			}
			const displayedDate = $(comicConfig.pageDate[0]).clone().children().remove().end().text().trim();
			const parsedDate = moment(displayedDate, comicConfig.pageDate[1], strictParsing);
			if (parsedDate.isValid()) {
				const convertedDate = parsedDate.format('YYYY-MM-DD');
				pageObj.pageDate = convertedDate;
			} else {
				if (!dateWarning) {
					dateWarning = true;
					drawMessage([
						`Invalid date format: "${displayedDate}" does not match "${comicConfig.pageDate[1]}"`,
						'(You will only get this warning once per comic)',
					]);
				}
				pageObj.pageDate = null;
			}
		} else {
			pageObj.pageDate = null;
		}
		// was this page already downloaded?
		// TODO check not just the last page (in case of e.g. edited pages or announcement pages that are deleted later)
		if (lastSaved === null || lastSaved !== pageObj.image) {
			newPages.unshift(pageObj);
			drawProgress(null, newPages.length);
			nextLinkToCheck = $(comicConfig.previousPageLink).attr('href');
			// is there a previous page (or is this page 1)?
			if (!nextLinkToCheck) {
				break;
			}
			nextLinkToCheck = resolveUrl(nextLinkToCheck, comicConfig.firstPageUrl);
			// special handling for those comics that don't disable the "previous" button on the first page
			if (nextLinkToCheck === pageObj.pageUrl) {
				break;
			}
		} else {
			break;
		}
	}
	// download new images
	let pageNumber = existingPages.length;
	let downloaded = 0;
	drawProgress(downloaded, newPages.length);

	process.removeAllListeners('SIGINT');
	process.once('SIGINT', () => {
		// interrupted while downloading new pages
		interrupted = true;
		drawMessage('Interrupted by user...');
		drawProgress(downloaded, newPages.length);
	});

	for (const page of newPages) {
		if (interrupted) {
			break;
		}

		pageNumber++;
		try {
			await saveImage(comicConfig.name, pageNumber, page);
			existingPages.push(page.image);
			downloaded++;
			drawProgress(downloaded, newPages.length);
		} catch (err) {
			// make sure to save all already downloaded pages
			await saveExistingPages(comicConfig.name, existingPages);
			throw err;
		}
	}
	await saveExistingPages(comicConfig.name, existingPages);

	process.removeAllListeners('SIGINT');

	return downloaded;
}

/**
 * Checks if a comic configuration is valid
 * @param {ComicConfig} comicConfig The comic configuration to validate
 * @returns {Boolean} Whether the configuration is valid
 */
function validateComicConfig(comicConfig) {
	if (comicConfig.disabled) {
		return false;
	}
	if (typeof comicConfig.name !== 'string' || comicConfig.name.length === 0 || sanitize(comicConfig.name) !== comicConfig.name) {
		return false;
	}
	if (typeof comicConfig.firstPageUrl !== 'string' || comicConfig.firstPageUrl.length === 0) {
		return false;
	}
	if (!Array.isArray(comicConfig.latestPageLink) && typeof comicConfig.latestPageLink !== 'string') {
		return false;
	} else if (Array.isArray(comicConfig.latestPageLink) && comicConfig.latestPageLink.length < 2) {
		return false;
	} else if (typeof comicConfig.latestPageLink === 'string' && comicConfig.latestPageLink.length === 0) {
		return false;
	}
	if (typeof comicConfig.previousPageLink !== 'string' || comicConfig.previousPageLink.length === 0) {
		return false;
	}
	if (typeof comicConfig.image !== 'string' || comicConfig.image.length === 0) {
		return false;
	}
	if (comicConfig.altImage !== null && (typeof comicConfig.altImage !== 'string' || comicConfig.altImage.length === 0)) {
		return false;
	}
	if (typeof comicConfig.titleText !== 'boolean') {
		return false;
	}
	if (comicConfig.commentary !== null && (typeof comicConfig.commentary !== 'string' || comicConfig.commentary.length === 0)) {
		return false;
	}
	if (comicConfig.pageDate !== null && (!Array.isArray(comicConfig.pageDate) || comicConfig.pageDate.length < 2)) {
		return false;
	}
	if (comicConfig.pageTitle !== null && (typeof comicConfig.pageTitle !== 'string' || comicConfig.pageTitle.length === 0)) {
		return false;
	}
	return true;
}

function validateUserInput(input) {
	// TODO "update all existing downloads" option
	const inputComicIds = input.split(' '); // 1-indexed, as displayed to the user
	let validComicIds = []; // 0-indexed, as actually in the array

	if (inputComicIds.includes('0')) {
		validComicIds = Array(comics.length).fill().map((e, i) => i);
	} else {
		for (let i = 0; i < inputComicIds.length; ++i) {
			if (comics[inputComicIds[i] - 1]) {
				validComicIds.push(inputComicIds[i] - 1);
			}
		}
	}
	return validComicIds;
}
