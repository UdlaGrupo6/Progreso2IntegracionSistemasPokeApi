const express = require('express');
const { engine } = require('express-handlebars');
const axios = require('axios');
const path = require('path');
const mysql = require('mysql2/promise');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const fs = require('fs');

const app = express();

// Configurar Handlebars como motor de vistas
app.engine('hbs', engine({ extname: 'hbs', defaultLayout: 'main' }));
app.set('view engine', 'hbs');

// Configurar la carpeta pública
app.use(express.static('public'));

// Configuración para manejar datos POST
app.use(express.urlencoded({ extended: true, limit: '50mb', parameterLimit: 100000 }));
app.use(express.json({ limit: '50mb' }));

// Configuración de la base de datos
const dbConfig = {
    host: 'localhost',
    user: 'root',
    password: 'admin',
    database: 'pruebap2'
};

// Función para obtener todos los Pokémon con reintentos y límite de concurrencia
async function fetchAllPokemons() {
    let url = 'https://pokeapi.co/api/v2/pokemon?limit=100';
    let pokemons = [];

    while (url) {
        try {
            const response = await axios.get(url);
            pokemons = pokemons.concat(response.data.results);
            url = response.data.next; // Actualiza la URL para la siguiente página
        } catch (error) {
            console.error('Error fetching from PokeAPI:', error.message);
            url = null; // Salir del bucle en caso de error
        }
    }

    // Limitar el número de solicitudes simultáneas a 10
    const limit = 10;
    let index = 0;
    const pokemonDetails = [];

    while (index < pokemons.length) {
        const chunk = pokemons.slice(index, index + limit);
        const detailsChunk = await Promise.all(chunk.map(async (pokemon) => {
            try {
                const details = await axios.get(pokemon.url);
                return {
                    name: pokemon.name,
                    image: details.data.sprites.front_default || 'https://via.placeholder.com/150',
                    id: details.data.id
                };
            } catch (error) {
                console.error('Error fetching details for', pokemon.name, ':', error.message);
                return null;
            }
        }));
        pokemonDetails.push(...detailsChunk.filter(detail => detail !== null));
        index += limit;
    }

    return pokemonDetails;
}

// Ruta principal para mostrar productos
app.get('/', async (req, res) => {
    try {
        const searchQuery = req.query.search || '';
        const pokemons = await fetchAllPokemons();
        const filteredPokemons = pokemons.filter(pokemon =>
            pokemon.name.toLowerCase().includes(searchQuery.toLowerCase())
        );
        res.render('home', { pokemons: filteredPokemons, searchQuery });
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al obtener los datos de la PokeAPI');
    }
});

// Nueva ruta para actualizar los datos desde la API y guardarlos en la base de datos
app.get('/fetch-and-save', async (req, res) => {
    let connection;
    try {
        const pokemons = await fetchAllPokemons();

        // Conectar a la base de datos
        connection = await mysql.createConnection(dbConfig);

        // Utilizar una transacción para asegurar la atomicidad de las operaciones
        await connection.beginTransaction();

        for (const pokemon of pokemons) {
            // Verificar si el Pokémon ya existe en la base de datos
            const [rows] = await connection.execute('SELECT * FROM productos WHERE id = ?', [pokemon.id]);
            if (rows.length > 0) {
                // Actualizar la URL de la imagen si el Pokémon ya existe
                await connection.execute('UPDATE productos SET url = ? WHERE id = ?', [pokemon.image, pokemon.id]);
            } else {
                // Insertar nuevo Pokémon
                await connection.execute('INSERT INTO productos (id, name, url, cantidad) VALUES (?, ?, ?, ?)', [pokemon.id, pokemon.name, pokemon.image, 0]);
            }
        }

        // Confirmar la transacción
        await connection.commit();
        res.send('Datos actualizados y guardados en la base de datos.');
    } catch (error) {
        console.error('Error al actualizar y guardar los datos:', error);

        if (connection) {
            try {
                // Revertir la transacción en caso de error
                await connection.rollback();
            } catch (rollbackError) {
                console.error('Error al revertir la transacción:', rollbackError);
            }
        }

        res.status(500).send('Error al actualizar y guardar los datos.');
    } finally {
        if (connection) {
            await connection.end();
        }
    }
});

// Ruta para generar el CSV, guardar la orden en la base de datos y generar la factura
app.post('/generate-csv', async (req, res) => {
    const { selectedProducts, clienteNombre, clienteEmail, clienteDireccion } = req.body;

    if (!selectedProducts || !clienteNombre || !clienteEmail || !clienteDireccion) {
        return res.status(400).send('Por favor, completa todos los campos del formulario y selecciona al menos un producto.');
    }

    console.log('selectedProducts:', selectedProducts);
    console.log('clienteNombre:', clienteNombre);
    console.log('clienteEmail:', clienteEmail);
    console.log('clienteDireccion:', clienteDireccion);

    const productArray = Array.isArray(selectedProducts) ? selectedProducts : [selectedProducts];

    const records = productArray.map(product => {
        const [id, name] = product.split(',');
        const quantity = req.body[`quantity_${id}`];
        console.log(`Producto: ${name}, ID: ${id}, Cantidad: ${quantity}`);
        return {
            id,
            name,
            cantidad: quantity
        };
    });

    // Verifica que no haya datos faltantes antes de escribir el CSV o insertar en la base de datos
    for (const record of records) {
        if (!record.id || !record.name || !record.cantidad) {
            console.error('Datos faltantes:', record);
            return res.status(400).send('Hay datos faltantes en los productos seleccionados.');
        }
    }

    try {
        // Conectar a la base de datos
        const connection = await mysql.createConnection(dbConfig);

        // Utilizar una transacción para asegurar la atomicidad de las operaciones
        await connection.beginTransaction();

        // Generar un nuevo orden_id
        const [result] = await connection.execute('SELECT MAX(orden_id) AS max_id FROM ordenes');
        const ordenId = result[0].max_id ? result[0].max_id + 1 : 1;

        // Guardar cada producto en la tabla 'ordenes' con el mismo orden_id
        for (const record of records) {
            const [rows] = await connection.execute('SELECT id FROM productos WHERE name = ?', [record.name]);
            if (rows.length > 0) {
                const productId = rows[0].id;
                await connection.execute(
                    'INSERT INTO ordenes (orden_id, producto_id, cantidad, cliente_nombre, cliente_email, cliente_direccion) VALUES (?, ?, ?, ?, ?, ?)',
                    [ordenId, productId, record.cantidad, clienteNombre, clienteEmail, clienteDireccion]
                );

                // Actualizar la cantidad en la tabla de productos
                await connection.execute(
                    'UPDATE productos SET cantidad = cantidad - ? WHERE id = ?',
                    [record.cantidad, productId]
                );
            } else {
                console.log(`Producto no encontrado: ${record.name}`);
            }
        }

        // Asegurarse de que la ruta del archivo CSV existe o crearla
        const filePath = path.join('C:\\Users\\Oscar\\OneDrive\\csv', 'ordenes.csv'); // Cambia la ruta aquí
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // Generar el CSV
        const csvWriter = createCsvWriter({
            path: filePath,
            header: [
                { id: 'id', title: 'ID' },
                { id: 'name', title: 'Nombre' },
                { id: 'cantidad', title: 'Cantidad' }
            ]
        });

        await csvWriter.writeRecords(records);
        console.log('CSV generado correctamente.');

        // Confirmar la transacción
        await connection.commit();
        connection.end();
        res.send('Ordenes de compra guardadas en la base de datos y CSV generado en el escritorio.');
    } catch (error) {
        console.error('Error al guardar la orden de compra y generar el CSV:', error);

        try {
            if (connection) {
                // Revertir la transacción en caso de error
                await connection.rollback();
            }
        } catch (rollbackError) {
            console.error('Error al revertir la transacción:', rollbackError);
        }

        res.status(500).send('Error al guardar la orden de compra y generar el CSV.');
    }
});

// Ruta para obtener facturas
app.get('/invoices', async (req, res) => {
    try {
        // Conectar a la base de datos
        const connection = await mysql.createConnection(dbConfig);

        // Obtener todas las facturas con los detalles de la orden y los productos
        const [facturas] = await connection.execute(`
            SELECT f.id AS factura_id, f.orden_id, f.fecha, f.total, 
                   o.cliente_nombre, o.cliente_email, o.cliente_direccion, 
                   p.name AS producto_nombre, p.url AS producto_url, o.cantidad AS producto_cantidad
            FROM facturas f
            JOIN ordenes o ON f.orden_id = o.orden_id
            JOIN productos p ON o.producto_id = p.id
        `);

        console.log(facturas); // Agregar log para depurar
        connection.end();

        res.render('invoices', { facturas });
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al obtener las facturas.');
    }
});

// Ruta para ver los productos
app.get('/productos', async (req, res) => {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const [rows] = await connection.execute('SELECT * FROM productos');
        connection.end();
        res.render('productos', { productos: rows });
    } catch (error) {
        console.error('Error al obtener los productos:', error);
        res.status(500).send('Error al obtener los productos.');
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});
