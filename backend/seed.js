import {db} from './db.js';
const rows=[
[2010,'Toyota','Camry',158200,5900],[2015,'Toyota','Camry',112400,10900],[2020,'Toyota','Camry',72600,18900],
[2012,'Toyota','Prius',173500,6500],[2015,'Toyota','Prius',129800,9400],[2018,'Toyota','Prius',91200,14500],
[2013,'Toyota','Corolla',147900,7400],[2018,'Toyota','Corolla',87300,12900],
[2012,'Honda','Civic',155600,6900],[2015,'Honda','Civic',108700,10500]];
try {
 for (const [[year,make,model,miles,price],i] of rows.map((r,i)=>[r,i])) {
   await db.query('INSERT INTO inventory (stock_number,year,make,model,mileage,asking_price_cents,availability) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (stock_number) DO NOTHING',
    ['DA-'+String(i+1).padStart(3,'0'),year,make,model,miles,price*100,i===9?'sold':i===5?'pending':'available']);
 }
 console.log('Demo inventory ready');
} finally {await db.end();}
