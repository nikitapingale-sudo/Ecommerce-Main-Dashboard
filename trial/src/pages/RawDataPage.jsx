import React, { useState, useEffect, useRef } from 'react';
import { DataTable, Pill, SearchBox } from '../components/UI';
import { fetchRows, downloadFilteredCsv, fmt, STATUS_COLOR, ITEM_STATUS_COLOR } from '../utils/dataEngine';

const PAGE_LIMIT = 500;   // rows shown in the on-screen table (full set is exportable)

export default function RawDataPage({ data, filters }) {
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const reqId = useRef(0);

  // Download EVERY matching row (server-side CSV, not just the loaded page).
  const exportAll = () => downloadFilteredCsv({ filters, search, name: 'raw_orders_filtered' });

  // Fetch a page of raw rows from the server whenever filters/search change
  // (debounced for typing). Only the current filter set is queried — never
  // the whole dataset — so this stays fast regardless of window size.
  useEffect(() => {
    const myReq = ++reqId.current;
    setLoading(true);
    const t = setTimeout(() => {
      fetchRows({ filters, search, limit: PAGE_LIMIT, offset: 0 })
        .then(res => {
          if (myReq !== reqId.current) return;
          setRows(res.rows || []); setTotal(res.total || 0); setLoading(false);
        })
        .catch(() => { if (myReq === reqId.current) setLoading(false); });
    }, search ? 350 : 0);
    return () => clearTimeout(t);
  }, [filters, search]);

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
        <SearchBox value={search} onChange={setSearch} width={460}
          placeholder="Search order no, customer, product, SKU… (searches all matching rows)"/>
        <span style={{ fontSize:12, color:'var(--text3)', marginLeft:'auto' }}>
          {loading ? 'Loading…'
            : `Showing ${rows.length.toLocaleString()} of ${total.toLocaleString()} matching rows · use Export for all`}
        </span>
      </div>

      <DataTable
        title="Raw Order Data"
        data={rows}
        totalRows={total}
        searchable={false}
        onExport={exportAll}
        exportLabel={`Export all (${total.toLocaleString()})`}
        columns={[
          { key:'order_date', label:'Date', bold:true },
          { key:'vco_external_order_number', label:'Order No', bold:true },
          { key:'unique_id', label:'Unique ID' },
          { key:'vco_customer_name', label:'Customer' },
          { key:'vco_channel_name', label:'Channel' },
          { key:'vco_brand', label:'Brand' },
          { key:'parent_name', label:'Category' },
          { key:'sub_cat_name', label:'Sub Cat' },
          { key:'product_name', label:'Product' },
          { key:'vco_sku_code', label:'SKU' },
          { key:'order_category', label:'Order Cat' },
          { key:'finance_exam_category', label:'Fin Cat' },
          { key:'payment_sources', label:'Payment' },
          { key:'purchase_level', label:'Purchase Lvl' },
          { key:'order_type', label:'Order Type' },
          { key:'oms', label:'OMS' },
          { key:'order_status_group', label:'Order Status',
            render:(v)=><Pill color={STATUS_COLOR[v]||'#64748b'}>{v}</Pill> },
          { key:'item_status_group', label:'Item Status',
            render:(v)=><Pill color={ITEM_STATUS_COLOR[v]||'#64748b'}>{v}</Pill> },
          { key:'qty', label:'Qty', right:true },
          { key:'final_revenue', label:'Revenue', right:true, render:v=>fmt(v) },
          { key:'mrp', label:'MRP', right:true, render:v=>fmt(v) },
          { key:'vco_unit_price', label:'Unit Price', right:true, render:v=>fmt(v) },
          { key:'delivery_charge', label:'Del Charge', right:true, render:v=>fmt(v) },
          { key:'city', label:'City' },
          { key:'state', label:'State' },
          { key:'warehouse', label:'Warehouse' },
          { key:'delivery_partner', label:'Courier' },
        ]}
        filename="raw_order_data"
        maxH={600}
      />
    </div>
  );
}
