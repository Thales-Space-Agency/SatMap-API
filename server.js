const express = require('express');
const fs = require('fs');
const satellite = require('satellite.js');
const winston = require('winston');

const app = express();
const port = 4000;

const satFilePath = 'sat.json';

const logger = winston.createLogger({
    level: 'error',
    format: winston.format.json(),
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' })
    ]
});

app.use(express.json());

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*'); // or '*' for allowing any origin
    next();
});

app.get('/api/update-sat', async (req, res) => {
    const save = await updateSatellitesFromAPI();

    if (!save) {
        return res.status(500).send("Erreur lors de l'enregistrement des données.");
    }

    res.send('Données satellites mises à jour avec succès');

});

app.get('/api/get-sat', (req, res) => {

    fs.readFile(satFilePath, 'utf8', function(err, data) {
        if (err) {
            return res.status(500).send("Erreur lors de la récupération des données.");
        }
        res.send(data);
    });

});

app.listen(port, () => {
    console.log(`Serveur Node.js en écoute sur http://localhost:${port}`);
});

let satellites = [];

function updateSatellitesFromAPI() {
    const satellitesPerPage = 100;
    const maxConcurrentRequests = 10;
    let page = getLastPage() + 1;
    let totalSatellites = 0;

    function fetchPage(page) {
        return fetch(`https://tle.ivanstanojevic.me/api/tle?page=${page}&page-size=${satellitesPerPage}`)
            .then(response => {
                if (!response.ok) {
                    throw new Error(`Erreur HTTP ! statut: ${response.status}`);
                }
                return response.json();
            });
    }

    function processBatch(batch, currentPage) {
        console.log(`Récupération des TLE de la page ${page} à la page ${page + maxConcurrentRequests - 1}...`);

        const promises = batch.map(page => fetchPageWithTimeout(page, 40000)); // 10000 ms = 10 secondes de timeout

        return Promise.allSettled(promises)
            .then(results => {
                results.forEach((result, index) => {
                    if (result.status === 'fulfilled') {
                        totalSatellites = result.value.totalItems;
                        result.value.member.forEach(async member => {

                            // Convertir les données TLE en coordonnées 3D
                            const coords = await tleTo3dCoordinates(member.line1, member.line2);

                            satellites.push({
                                name: member.name,
                                line1: member.line1,
                                line2: member.line2,
                                id: member.satelliteId,
                                date: member.date,
                                coords: coords
                            });
                            saveLastPage(currentPage + index);
                        });
                    } else {
                        console.error(`Erreur lors de la récupération d'une page : ${result.reason}`);
                    }
                });
            });
    }

    function fetchPageWithTimeout(page, timeout) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`La requête a expiré pour la page ${page}`));
            }, timeout);

            fetchPage(page).then(response => {
                clearTimeout(timer);
                resolve(response);
            }).catch(error => {
                clearTimeout(timer);
                reject(error);
            });
        });
    }

    function processAllPages() {
        try {
            // Récupérer le nombre total de satellites pour calculer le nombre total de pages
            return fetchPage(1)
                .then(initialData => {
                    totalSatellites = initialData.totalItems;
                    const totalPages = Math.ceil(totalSatellites / satellitesPerPage);

                    while (page <= totalPages) {
                        const endPage = Math.min(page + maxConcurrentRequests - 1, totalPages);
                        const batch = [];

                        for (let i = page; i <= endPage; i++) {
                            batch.push(i);
                        }

                        return processBatch(batch, page)
                            .then(() => {
                                page += maxConcurrentRequests;
                                console.log(`Nombre de satellites récupérés : ${satellites.length}`);
                                console.log(`Nombre de satellites total : ${totalSatellites}`);
                            });
                    }

                    console.log("Récupération des TLE terminée");
                    return true;
                });

        } catch (error) {
            console.error('Erreur lors du traitement des données satellites :', error);
            return false;
        } finally {
            if (satellites.length > 0) {
                console.log('Sauvegarde des satellites récupérés...');
                saveSatellites();
            }
        }
    }

    return processAllPages();
}

function saveSatellites() {

    // Vérifie si le fichier existe, sinon crée un fichier vide
    if (!fs.existsSync(satFilePath)) {
        fs.writeFileSync(satFilePath, JSON.stringify([], null, 2), 'utf8');
    }

    fs.readFile(satFilePath, 'utf8', function (err, data) {
        if (err) {
            console.error("Une erreur est survenue lors de la lecture des données :", err);
            return false;
        }

        fs.writeFile(satFilePath, JSON.stringify(satellites, null, 2), 'utf8', function (err) {
            if (err) {
                console.error("Une erreur est survenue lors de l'écriture des données :", err);
                return;
            }
            console.log('Données satellites sauvegardées avec succès.');
        });
    });
}

const stateFilePath = 'lastPage.json';

function saveLastPage(page) {
    fs.writeFileSync(stateFilePath, JSON.stringify({ lastPage: page }), 'utf8');
}

function getLastPage() {
    if (fs.existsSync(stateFilePath)) {
        const data = fs.readFileSync(stateFilePath, 'utf8');
        const state = JSON.parse(data);
        return state.lastPage;
    }
    return 0; // Retourne 0 si le fichier n'existe pas
}

function tleTo3dCoordinates(tleLine1, tleLine2, unit = 1000) {
    try {
        const satrec = satellite.twoline2satrec(tleLine1, tleLine2);
        const date = new Date();
        const positionAndVelocity = satellite.propagate(satrec, date);
        if (!positionAndVelocity.position) {
            logger.error("Position indéterminée pour les données TLE fournies.");
        }
        const positionEci = positionAndVelocity.position;
        const gmst = satellite.gstime(date);
        const positionGd = satellite.eciToGeodetic(positionEci, gmst);
        const latitude = satellite.degreesLat(positionGd.latitude);
        const longitude = satellite.degreesLong(positionGd.longitude);
        const altitude = positionGd.height + 6371;
        const phi = (90 - latitude) * (Math.PI / 180);
        const theta = (90 - longitude) * (Math.PI / 180);
        const rho = altitude;
        const x = (rho * Math.sin(phi) * Math.cos(theta)) / unit;
        const y = (rho * Math.sin(phi) * Math.sin(theta)) / unit;
        const z = (rho * Math.cos(phi)) / unit;
        return { x, y, z };
    } catch (error) {
        logger.log('Erreur lors de la conversion des coordonnées :', error);
    }
}
