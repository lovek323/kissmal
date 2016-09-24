"use strict";

var Kissanime = require('anime-scraper').Anime;
var MyAnimeList = require('malapi').Anime;
var ProgressBar = require('progress');

var config = require('./config.json');
var kissanimeSeries = require('./cache/search.json');

var async = require('async');
var cheerio = require('cheerio');
var exec = require('child_process').exec;
var fs = require('fs');
var mkdirp = require('mkdirp');
var pad = require('pad');
var progress = require('request-progress');
var request = require('request');
var shellescape = require('shell-escape');
var util = require('util');

const debug = require('debug')('kissmal');

var provider = '9anime.to';
// var provider = 'kissanime.to';

String.prototype.replaceAll = function (search, replacement) {
  var target = this;
  return target.replace(new RegExp(search, 'g'), replacement);
};

var cachedRequest = (url, callback) => {
  var cacheFile = 'cache/' + new Buffer(url).toString('base64');
  if (fs.existsSync(cacheFile)) {
    var stat = fs.statSync(cacheFile);
    var mtime = new Date(util.inspect(stat.mtime));
    var yesterday = new Date(new Date().getTime() - (24 * 60 * 60 * 1000));
    if (mtime > yesterday) {
      callback(null, null, fs.readFileSync(cacheFile));
      return;
    }
  }
  request(url, (error, request, body) => {
    fs.writeFileSync(cacheFile, body);
    callback(error, request, body);
  });
};

var sanitise = string => {
  //noinspection JSUnresolvedFunction
  return string.replaceAll('"', '_').replaceAll(':', '_');
};

var getFileName = (malEpisode) => {
  return config.outputDirectory + '/' + pad(2, malEpisode.number, '0') + ' ' + sanitise(malEpisode.name) + '.mp4';
};

var getFinalFileName = (malEpisode, malSeries) => {
  var directory = config.finalDirectory + '/' + sanitise(malSeries.title);
  return directory + '/' + pad(2, malEpisode.number, '0') + ' ' + sanitise(malEpisode.name) + '.mp4';
};

var runSeries = function (series, nextSeries) {
  var seriesId = series.id;
  var cacheFile = "cache/" + seriesId + ".json";

  debug('Processing series: ' + seriesId);

  if (fs.existsSync(cacheFile)) {
    var stat = fs.statSync(cacheFile);
    var mtime = new Date(util.inspect(stat.mtime));
    var yesterday = new Date(new Date().getTime() - (24 * 60 * 60 * 1000));
    if (mtime > yesterday) {
      var cacheObject = require('./cache/' + seriesId);
      var malSeries = cacheObject.malSeries;
      var malEpisodeInformations = cacheObject.malEpisodeInformations;

      var titles = [];

      if (typeof config.seriesNameOverrides[seriesId] !== 'undefined') {
        titles = [config.seriesNameOverrides[seriesId]];
      } else {
        titles = [malSeries.title];
        titles = titles.concat(malSeries.alternativeTitles.english);
        titles = titles.concat(malSeries.alternativeTitles.synoynms)
      }

      async.eachSeries(titles, (title, nextTitle) => {
        if (provider === 'kissanime.to') {
          runSeriesKissanime(title, malSeries, malEpisodeInformations, nextTitle, nextSeries)
        } else {
          runSeries9Anime(title, malSeries, malEpisodeInformations, nextTitle, nextSeries)
        }
      }, nextSeries);
    }
    return;
  }

  MyAnimeList.fromId(seriesId).then(function (malSeries) {
    console.log('Fetching series ' + malSeries.title);

    var titles = [];

    if (typeof config.seriesNameOverrides[seriesId] !== 'undefined') {
      titles = [config.seriesNameOverrides[seriesId]];
    } else {
      titles = [malSeries.title];
      titles = titles.concat(malSeries.alternativeTitles.english);
      titles = titles.concat(malSeries.alternativeTitles.synoynms)
    }

    malSeries.getEpisodes().then(malEpisodes => {
      async.eachSeries(titles, (title, nextTitle) => {
        var malEpisodeInformations = [];
        async.eachSeries(malEpisodes, (malEpisode, nextMalEpisode) => {
          malEpisode.getInformation().then(malEpisodeInformation => {
            malEpisodeInformations.push(malEpisodeInformation);
            nextMalEpisode();
          });
        }, () => {
          var cacheFile = "cache/" + malSeries.id + ".json";
          var cacheObject = {malSeries, malEpisodeInformations};
          fs.writeFileSync(cacheFile, JSON.stringify(cacheObject));
          if (provider === 'kissanime.to') {
            runSeriesKissanime(title, malSeries, malEpisodeInformations, nextTitle, nextSeries)
          } else {
            runSeries9Anime(title, malSeries, malEpisodeInformations, nextTitle, nextSeries)
          }
        });
      });
    });
  });
};

var runSeriesKissanime = (title, malSeries, malEpisodeInformations, nextTitle, nextSeries) => {
  var url = null;

  //noinspection JSUnresolvedVariable
  for (var i = 0; i < kissanimeSeries.length; i++) {
    if (kissanimeSeries[i].name == title) {
      url = kissanimeSeries[i].url;
      break;
    }
  }

  if (url === null) {
    console.error('Could not find URL for ' + title + ' on kissanime.to');
    nextSeries();
    return;
  }

  Kissanime.fromUrl(url).then(kissanimeSeries => {
    kissanimeSeries.fetchAllEpisodes().then(kissanimeEpisodes => {
      async.eachSeries(kissanimeEpisodes, (kissanimeEpisode, nextEpisode) => {
        var kissanimeEpisodeNumber = kissanimeEpisode.name.match(/Episode ([0-9]+)/)[1];
        var malEpisodeInformation = null;

        for (var i = 0; i < malEpisodeInformations.length; i++) {
          if (malEpisodeInformations[i].number == kissanimeEpisodeNumber) {
            malEpisodeInformation = malEpisodeInformations[i];
            break;
          }
        }

        return downloadEpisode(
          malSeries,
          malEpisodeInformation,
          getBestVideoFromKissanimeEpisode(kissanimeEpisode),
          nextEpisode
        );
      }, nextSeries);
    });
  });
};

var runSeries9Anime = (title, malSeries, malEpisodeInformations, nextTitle, nextSeries) => {
  cachedRequest(
    'http://9anime.to/ajax/film/search?sort=year%3Adesc&keyword=' + encodeURIComponent(title),
    (error, response, body) => {
      body = JSON.parse(body);
      var $ = cheerio.load(body.html);
      $(".item a.name").each((index, element) => {
        var url = $(element).attr('href');
        var filmId = url.match(/\/(.*?)$/)[1];
        var name = $(element).text();
        if (name.toLowerCase() === title.toLowerCase()) {
          cachedRequest(url, (error, response, body) => {
            var $ = cheerio.load(body);
            var episodes = {};
            $("ul.episodes a").each((index, element) => {
              var id = $(element).data("id");
              var name = $(element).text();
              if (typeof episodes[name] === 'undefined') {
                episodes[name] = [];
              }
              episodes[name].push(id);
            });

            async.eachSeries(Object.keys(episodes), (episode, nextEpisode) => {
              var episodeId = episodes[episode][0];
              var episodeNumber = parseInt(episode.match(/^([0-9]+)/)[1]);
              var malEpisodeInformation = null;

              for (var i = 0; i < malEpisodeInformations.length; i++) {
                if (malEpisodeInformations[i].number == episodeNumber) {
                  malEpisodeInformation = malEpisodeInformations[i];
                  break;
                }
              }

              var fileName = getFileName(malEpisodeInformation);
              var finalFileName = getFinalFileName(malEpisodeInformation, malSeries);

              if (fs.existsSync(fileName) || fs.existsSync(finalFileName)) {
                nextEpisode();
                return;
              }

              request(
                'http://9anime.to/ajax/episode/info?id=' + episodeId + '&update=0&film=' + filmId,
                (error, response, body) => {
                  body = JSON.parse(body);
                  //noinspection JSUnresolvedVariable
                  var url = body.grabber + '?id=' + episodeId + '&token=' + body.params.token + '&options=' +
                    body.params.options + '&mobile=0';

                  request(url, (error, response, body) => {
                    body = JSON.parse(body);

                    return downloadEpisode(
                      malSeries,
                      malEpisodeInformation,
                      getBestVideoFrom9AnimeEpisode(body),
                      nextEpisode
                    );
                  });
                }
              )
            }, nextSeries);
          });
        }
      });
    }
  );
};

var downloadEpisode = function (malSeries, mapEpisodeInformation, bestVideo, next) {
  var episodeName = 'Episode ' + mapEpisodeInformation.number;
  var synopsis = '';
  var genre = '';
  var contentRating = '';

  if (mapEpisodeInformation !== null) {
    episodeName = mapEpisodeInformation.name;
    synopsis = mapEpisodeInformation.synopsis;
    genre = malSeries.genres[0];
  }

  switch (malSeries.classification) {
    case "PG-13 - Teens 13 or older":
      contentRating = "PG-13";
      break;
    default:
      throw new Error('Unrecognised classification: ' + malSeries.classification);
  }

  var malAired = malSeries.aired.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([0-9]{2}), ([0-9]{4})/);
  var malYear = malAired[3];

  var fileName = getFileName(mapEpisodeInformation);
  var finalFileName = getFinalFileName(mapEpisodeInformation, malSeries);

  console.log('Downloading ' + mapEpisodeInformation.number + ' - ' + mapEpisodeInformation.name + ' (' +
    bestVideo.resolution + 'p) to ' + finalFileName);

  if (fs.existsSync(fileName) || fs.existsSync(finalFileName)) {
    next();
    return;
  }

  var jpgFile = fs.createWriteStream('temp.jpg');
  jpgFile.on('finish', function () {
    var mp4File = fs.createWriteStream('temp.mp4');
    mp4File.on('finish', function () {
      var args = [
        'AtomicParsley',
        'temp.mp4',
        '--overWrite',
        '--genre',
        genre,
        '--stik',
        'TV Show',
        '--TVShowName',
        malSeries.title,
        '--TVEpisodeNum',
        mapEpisodeInformation.number,
        '--artwork',
        'temp.jpg',
        '--year',
        malYear,
        '--longdesc',
        synopsis,
        '--storedesc',
        malSeries.synopsis,
        '--title',
        episodeName,
        '--tracknum',
        mapEpisodeInformation.number + '/' + malSeries.episodes,
        '--contentRating',
        contentRating
      ];
      var cmd = shellescape(args);
      exec(cmd, error => {
        if (error) {
          debug(error);
          fs.unlinkSync("cache/" + malSeries.id + ".json");
          process.exit(1);
          return;
        }
        fs.renameSync('temp.mp4', fileName);
        console.log("");
        next();
      });
    });
    //noinspection JSUnresolvedFunction
    var bar = new ProgressBar(':bar :elapseds elapsed :percent :etas remaining', {total: 100});
    //noinspection JSUnresolvedFunction
    progress(request({url: bestVideo.url, method: 'GET', followAllRedirects: true}))
      .on('progress', state => bar.update(state.percentage))
      .pipe(mp4File);
  });
  //noinspection JSUnresolvedFunction
  request({url: malSeries.image, method: 'GET', followAllRedirects: true}).pipe(jpgFile);
};

var getBestVideoFromKissanimeEpisode = (kissanimeEpisode) => {
  var bestLink = null;
  var bestResolution = 0;

  for (var k = 0; k < kissanimeEpisode.video_links.length; k++) {
    var video = kissanimeEpisode.video_links[k];
    var resolution = 0;
    switch (video.name) {
      case '1080p':
        resolution = 1080;
        break;
      case '720p':
        resolution = 720;
        break;
      case '480p':
        resolution = 480;
        break;
      case '360p':
        resolution = 360;
        break;
      default:
        throw new Error('Unrecognised resolution: ' + video.name);
    }
    if (bestResolution < resolution) {
      bestResolution = resolution;
      bestLink = video.url;
    }
  }

  return {url: bestLink, resolution: bestResolution};
};

var getBestVideoFrom9AnimeEpisode = (_9AnimeEpisode) => {
  var bestLink = null;
  var bestResolution = 0;

  for (var k = 0; k < _9AnimeEpisode.data.length; k++) {
    var video = _9AnimeEpisode.data[k];
    var resolution = 0;
    switch (video.label) {
      case '1080p':
        resolution = 1080;
        break;
      case '720p':
        resolution = 720;
        break;
      case '480p':
        resolution = 480;
        break;
      case '360p':
        resolution = 360;
        break;
      default:
        throw new Error('Unrecognised resolution: ' + video.name);
    }
    if (bestResolution < resolution) {
      bestResolution = resolution;
      bestLink = video.file;
    }
  }

  return {url: bestLink, resolution: bestResolution};
};
async.eachSeries(config.series, runSeries);

/* Kissanime.search('').then(function (results) {
 var cacheFile = "cache/search.json";
 fs.writeFileSync(cacheFile, JSON.stringify(results));
 }); */