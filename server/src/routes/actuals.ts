import { Router } from 'express';

const router = Router();

router.get('/clinic', async (req, res) => {
  const db = req.tenantDb!;
  const { fy_id } = req.query;

  if (fy_id) {
    const fy = db.get('SELECT * FROM financial_years WHERE id = ?', fy_id);
    if (fy) {
      res.json(db.all(
        'SELECT * FROM clinic_monthly_summary WHERE bill_month >= ? AND bill_month <= ? ORDER BY bill_month, department',
        fy.start_date.slice(0, 7), fy.end_date.slice(0, 7)
      ));
      return;
    }
  }
  res.json(db.all('SELECT * FROM clinic_monthly_summary ORDER BY bill_month, department'));
});

router.get('/clinic/doctors', async (req, res) => {
  const db = req.tenantDb!;
  const { fy_id, month } = req.query;

  if (month) {
    res.json(db.all('SELECT * FROM clinic_doctor_summary WHERE bill_month = ? ORDER BY total_revenue DESC', month));
  } else if (fy_id) {
    const fy = db.get('SELECT * FROM financial_years WHERE id = ?', fy_id);
    if (fy) {
      res.json(db.all(
        'SELECT * FROM clinic_doctor_summary WHERE bill_month >= ? AND bill_month <= ? ORDER BY total_revenue DESC',
        fy.start_date.slice(0, 7), fy.end_date.slice(0, 7)
      ));
      return;
    }
  }
  res.json(db.all('SELECT * FROM clinic_doctor_summary ORDER BY total_revenue DESC'));
});

router.get('/pharmacy', async (req, res) => {
  const db = req.tenantDb!;
  const { fy_id } = req.query;

  if (fy_id) {
    const fy = db.get('SELECT * FROM financial_years WHERE id = ?', fy_id);
    if (fy) {
      res.json(db.all(
        'SELECT * FROM pharmacy_monthly_summary WHERE bill_month >= ? AND bill_month <= ? ORDER BY bill_month',
        fy.start_date.slice(0, 7), fy.end_date.slice(0, 7)
      ));
      return;
    }
  }
  res.json(db.all('SELECT * FROM pharmacy_monthly_summary ORDER BY bill_month'));
});

router.get('/pharmacy/purchases', async (req, res) => {
  const db = req.tenantDb!;
  const { fy_id } = req.query;

  if (fy_id) {
    const fy = db.get('SELECT * FROM financial_years WHERE id = ?', fy_id);
    if (fy) {
      res.json(db.all(
        'SELECT * FROM pharmacy_purchase_monthly_summary WHERE invoice_month >= ? AND invoice_month <= ? ORDER BY invoice_month',
        fy.start_date.slice(0, 7), fy.end_date.slice(0, 7)
      ));
      return;
    }
  }
  res.json(db.all('SELECT * FROM pharmacy_purchase_monthly_summary ORDER BY invoice_month'));
});

export default router;
